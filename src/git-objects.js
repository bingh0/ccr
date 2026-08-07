// @ts-check
'use strict';
// src/git-objects.js — read commits and trees out of `.git/objects`, without git.
//
// Third stop of the build fork (src/git-repo.js header): the pane parses `.git`
// itself, and the working-tree and history sections both need real objects —
// staged-ness is "does the index entry differ from HEAD's tree", which cannot
// be answered without reading that tree. The byte-level contract lives in
// features/design/git-object-store.feature.
//
// ONLY COMMITS AND TREES ARE EVER REQUESTED. The modified-check hashes worktree
// files and compares AGAINST index oids, so blob CONTENT is never read — which
// is why the size cap can be modest. A repository whose history the pane wants
// is made of objects a few KB each; a cap that would refuse a giant vendored
// blob refuses nothing the pane asks for.
//
// PACKFILES ARE NOT OPTIONAL. Every clone and every gc leaves most objects
// packed; a loose-only reader would work in a demo repo and degrade in every
// repository anyone actually uses. Pack index v2 and both delta forms
// (ofs-delta, ref-delta) are supported; v1 pack indexes (pre-2008) are not,
// and degrade to null like every other surprise.
//
// EVERY FAILURE IS null. The caller says "git data unavailable"
// (features/git-pane-safety.feature) — honest, and the exact opposite of
// guessing at history. All reads go through readBytesCapped: regular files
// only, size-capped, never blocking, so a fifo planted in .git/objects cannot
// wedge the draw loop (the safety feature's wedging scenarios).

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { readBytesCapped, readTextCapped } = require('./safe-read');

// Caps. An object the pane reads (commit, tree) is small; the pack caps are
// roofs against corruption, not budgets the code approaches.
const OBJECT_MAX_BYTES = 8 * 1024 * 1024;     // one inflated object
const PACK_IDX_MAX_BYTES = 128 * 1024 * 1024; // linux kernel idx is ~90 MB
const MAX_DELTA_DEPTH = 64;                   // git's own effective ceiling
const MAX_PACKS = 256;

/** @typedef {{ type: 'commit'|'tree'|'blob'|'tag', data: Buffer }} GitObject */

/**
 * Inflate with a hard output cap, never throwing. The cap matters: zlib is a
 * compression format, so a 100-byte planted file can claim to inflate to
 * gigabytes; maxOutputLength makes that a null, not an allocation.
 * @param {Buffer} buf
 * @param {number} [cap]
 * @returns {Buffer|null}
 */
function inflateCapped(buf, cap = OBJECT_MAX_BYTES) {
  try {
    return zlib.inflateSync(buf, { maxOutputLength: cap });
  } catch {
    return null;
  }
}

/**
 * Read a loose object: `.git/objects/aa/bbbb…`, zlib-deflated
 * `"<type> <size>\0<data>"`.
 * @param {string} gitDir
 * @param {string} oid
 * @returns {GitObject|null}
 */
function readLoose(gitDir, oid) {
  const file = path.join(gitDir, 'objects', oid.slice(0, 2), oid.slice(2));
  const raw = readBytesCapped(file, OBJECT_MAX_BYTES);
  if (raw === null) return null;
  const inflated = inflateCapped(raw);
  if (inflated === null) return null;
  const nul = inflated.indexOf(0);
  if (nul === -1 || nul > 32) return null;
  const m = /^(commit|tree|blob|tag) (\d{1,10})$/.exec(inflated.toString('latin1', 0, nul));
  if (!m) return null;
  const data = inflated.subarray(nul + 1);
  if (data.length !== Number(m[2])) return null;
  return { type: /** @type {GitObject['type']} */ (m[1]), data };
}

/**
 * A pack entry's position, from its `.idx` (version 2 only).
 *
 * The idx layout: 8-byte magic+version, 256×4 fanout, then N hashes, N CRCs,
 * N 4-byte offsets — an offset with its MSB set indexes a table of 8-byte
 * offsets after it (packs over 2 GB).
 *
 * @param {Buffer} idx
 * @param {string} oid
 * @param {number} hashBytes
 * @returns {number|null}  Byte offset into the .pack, or null when absent.
 */
function packOffset(idx, oid, hashBytes) {
  if (idx.length < 8 + 256 * 4 || idx.readUInt32BE(0) !== 0xff744f63 || idx.readUInt32BE(4) !== 2) return null;
  const fanout = 8;
  // The caller validated the oid as lowercase hex; the first byte picks the
  // fanout bucket.
  const first = parseInt(oid.slice(0, 2), 16);
  if (!Number.isInteger(first) || first < 0 || first > 255) return null;
  const total = idx.readUInt32BE(fanout + 255 * 4);
  const lo0 = first === 0 ? 0 : idx.readUInt32BE(fanout + (first - 1) * 4);
  const hi0 = idx.readUInt32BE(fanout + first * 4);
  const names = fanout + 256 * 4;
  const target = Buffer.from(oid, 'hex');
  if (target.length !== hashBytes) return null;

  let lo = lo0;
  let hi = hi0;
  const need = names + total * hashBytes; // hashes table must fit
  if (need > idx.length || hi > total || lo > hi) return null;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const at = names + mid * hashBytes;
    const cmp = target.compare(idx, at, at + hashBytes);
    if (cmp === 0) {
      const offsets = names + total * hashBytes + total * 4; // skip CRC table
      const o32at = offsets + mid * 4;
      if (o32at + 4 > idx.length) return null;
      const o32 = idx.readUInt32BE(o32at);
      if ((o32 & 0x80000000) === 0) return o32;
      const bigAt = offsets + total * 4 + (o32 & 0x7fffffff) * 8;
      if (bigAt + 8 > idx.length) return null;
      const big = idx.readBigUInt64BE(bigAt);
      return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : null;
    }
    if (cmp < 0) hi = mid; else lo = mid + 1;
  }
  return null;
}

/**
 * Apply a git delta: a source-size varint and target-size varint, then copy
 * (from base) and insert (literal) instructions until the target is built.
 * @param {Buffer} base
 * @param {Buffer} delta
 * @returns {Buffer|null}
 */
function applyDelta(base, delta) {
  let off = 0;
  const varint = () => {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (off >= delta.length || shift > 49) return null;
      const b = delta[off]; off += 1;
      v += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return v;
      shift += 7;
    }
  };
  const srcSize = varint();
  const outSize = varint();
  if (srcSize === null || outSize === null) return null;
  if (srcSize !== base.length || outSize > OBJECT_MAX_BYTES) return null;
  const out = Buffer.alloc(outSize);
  let at = 0;
  while (off < delta.length) {
    const cmd = delta[off]; off += 1;
    if (cmd & 0x80) {
      // Copy from base: bits 0-3 select offset bytes, 4-6 size bytes.
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (cmd & (1 << i)) { if (off >= delta.length) return null; cpOff |= delta[off] << (8 * i); off += 1; }
      }
      for (let i = 0; i < 3; i += 1) {
        if (cmd & (0x10 << i)) { if (off >= delta.length) return null; cpSize |= delta[off] << (8 * i); off += 1; }
      }
      if (cpSize === 0) cpSize = 0x10000;
      cpOff >>>= 0;
      if (cpOff + cpSize > base.length || at + cpSize > outSize) return null;
      base.copy(out, at, cpOff, cpOff + cpSize);
      at += cpSize;
    } else if (cmd > 0) {
      // Insert literal bytes.
      if (off + cmd > delta.length || at + cmd > outSize) return null;
      delta.copy(out, at, off, off + cmd);
      off += cmd;
      at += cmd;
    } else {
      return null; // cmd 0 is reserved and means corruption
    }
  }
  return at === outSize ? out : null;
}

const PACK_TYPE = /** @type {const} */ ({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' });

/**
 * Read one object out of a `.pack` at a known offset, resolving deltas
 * recursively (bounded), against an open descriptor — packfiles can be huge,
 * so unlike every other read here the file is NOT slurped; each entry reads
 * only the bytes it needs.
 *
 * @param {{ fd: number, size: number, idx: Buffer, hashBytes: number }} pack
 * @param {number} offset
 * @param {number} depth
 * @returns {GitObject|null}
 */
function readPacked(pack, offset, depth) {
  if (depth > MAX_DELTA_DEPTH || offset < 12 || offset >= pack.size) return null;
  // An entry's header is a size varint with a 3-bit type; the deflated data
  // follows. We read a window generously sized for headers + base offsets.
  const head = Buffer.alloc(Math.min(64, pack.size - offset));
  try { fs.readSync(pack.fd, head, 0, head.length, offset); } catch { return null; }
  if (head.length < 2) return null;
  let b = head[0];
  const typeNum = (b >> 4) & 0x7;
  let size = b & 0xf;
  let shift = 4;
  let hOff = 1;
  while (b & 0x80) {
    if (hOff >= head.length || shift > 53) return null;
    b = head[hOff]; hOff += 1;
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  if (size > OBJECT_MAX_BYTES) return null;

  /** @type {Buffer|null} */
  let baseData = null;
  /** @type {GitObject['type']|null} */
  let baseType = null;
  if (typeNum === 6) {
    // ofs-delta: a varint (the +1-before-shift form) giving the DISTANCE back
    // to the base entry's offset.
    if (hOff >= head.length) return null;
    b = head[hOff]; hOff += 1;
    let dist = b & 0x7f;
    let hops = 0;
    while (b & 0x80) {
      if (hOff >= head.length || hops > 7) return null;
      b = head[hOff]; hOff += 1;
      dist = ((dist + 1) * 128) + (b & 0x7f);
      hops += 1;
    }
    const base = readPacked(pack, offset - dist, depth + 1);
    if (base === null) return null;
    baseData = base.data;
    baseType = base.type;
  } else if (typeNum === 7) {
    // ref-delta: the base's full hash, then the delta.
    if (hOff + pack.hashBytes > head.length) return null;
    const baseOid = head.toString('hex', hOff, hOff + pack.hashBytes);
    hOff += pack.hashBytes;
    const at = packOffset(pack.idx, baseOid, pack.hashBytes);
    // The base is almost always in the same pack; a thin pack's external base
    // would need the whole store, and a null here degrades honestly.
    const base = at === null ? null : readPacked(pack, at, depth + 1);
    if (base === null) return null;
    baseData = base.data;
    baseType = base.type;
  } else if (!(typeNum in PACK_TYPE)) {
    return null;
  }

  // Inflate the entry's data. The deflated length is not recorded, so read a
  // bounded window from the entry body to the end cap and let zlib stop at the
  // stream's own end.
  const bodyAt = offset + hOff;
  const windowLen = Math.min(pack.size - bodyAt, size + 1024, OBJECT_MAX_BYTES);
  if (windowLen <= 0) return null;
  const body = Buffer.alloc(windowLen);
  try { fs.readSync(pack.fd, body, 0, windowLen, bodyAt); } catch { return null; }
  const inflated = inflateCapped(body, size);
  if (inflated === null || inflated.length !== size) return null;

  if (baseData !== null) {
    const restored = applyDelta(baseData, inflated);
    return restored === null || baseType === null ? null : { type: baseType, data: restored };
  }
  return { type: PACK_TYPE[/** @type {1|2|3|4} */ (typeNum)], data: inflated };
}

/**
 * Read an object by id: loose first (cheap, and where fresh objects live),
 * then every pack. Missing everywhere → null.
 *
 * @param {string} gitDir
 * @param {string} oid  Lowercase hex, 40 or 64 chars.
 * @returns {GitObject|null}
 */
function readObject(gitDir, oid) {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(oid)) return null;
  const loose = readLoose(gitDir, oid);
  if (loose !== null) return loose;

  const hashBytes = oid.length / 2;
  const packDir = path.join(gitDir, 'objects', 'pack');
  /** @type {string[]} */
  let names = [];
  try { names = fs.readdirSync(packDir).filter((n) => n.endsWith('.idx')).slice(0, MAX_PACKS); } catch { return null; }
  for (const name of names) {
    const idx = readBytesCapped(path.join(packDir, name), PACK_IDX_MAX_BYTES);
    if (idx === null) continue;
    const at = packOffset(idx, oid, hashBytes);
    if (at === null) continue;
    const packPath = path.join(packDir, name.slice(0, -4) + '.pack');
    let fd = -1;
    try {
      let st;
      try { st = fs.lstatSync(packPath); } catch { st = null; }
      if (st === null || !st.isFile()) continue;
      fd = fs.openSync(packPath, 'r');
      const fst = fs.fstatSync(fd);
      if (!fst.isFile()) continue;
      const got = readPacked({ fd, size: fst.size, idx, hashBytes }, at, 0);
      if (got !== null) return got;
    } catch {
      // fall through to the next pack
    } finally {
      if (fd !== -1) { try { fs.closeSync(fd); } catch { /* closed */ } }
    }
  }
  return null;
}

/**
 * Resolve a ref name ("refs/heads/main") to an object id: the loose ref file
 * first, then `packed-refs`. Null when the ref does not exist — which is what
 * an unborn branch looks like, and is a state, not an error.
 *
 * @param {string} gitDir
 * @param {string} ref
 * @returns {string|null}
 */
function resolveRef(gitDir, ref) {
  if (!/^refs\/[\x21-\x7e]+$/.test(ref) || ref.includes('..')) return null;
  const loose = readTextCapped(path.join(gitDir, ...ref.split('/')), 4096);
  if (loose !== null) {
    const line = loose.split('\n')[0].trim();
    if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(line)) return line.toLowerCase();
    return null;
  }
  const packed = readTextCapped(path.join(gitDir, 'packed-refs'), 4 * 1024 * 1024);
  if (packed === null) return null;
  for (const line of packed.split('\n')) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const sp = line.indexOf(' ');
    if (sp === -1) continue;
    if (line.slice(sp + 1).trim() === ref) {
      const oid = line.slice(0, sp).trim().toLowerCase();
      if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(oid)) return oid;
    }
  }
  return null;
}

/**
 * The object id HEAD points at, following one level of symbolic ref. Null for
 * an unborn branch (fresh `git init`) and for anything unreadable.
 * @param {string} gitDir
 * @returns {string|null}
 */
function resolveHead(gitDir) {
  const raw = readTextCapped(path.join(gitDir, 'HEAD'), 4096);
  if (raw === null) return null;
  const line = raw.split('\n')[0].trim();
  const m = /^ref:[ \t]*(.+)$/.exec(line);
  if (m) return resolveRef(gitDir, m[1].trim());
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(line) ? line.toLowerCase() : null;
}

/**
 * Parse a tree object's entries: `"<octal mode> <name>\0<raw hash>"` repeated.
 * @param {Buffer} data
 * @param {number} hashBytes
 * @returns {Array<{ mode: number, name: string, oid: string }>|null}
 */
function parseTree(data, hashBytes) {
  const out = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1 || sp - off > 7) return null;
    const mode = parseInt(data.toString('latin1', off, sp), 8);
    if (!Number.isInteger(mode)) return null;
    const nul = data.indexOf(0, sp + 1);
    if (nul === -1 || nul + hashBytes >= data.length + 1) return null;
    if (nul + 1 + hashBytes > data.length) return null;
    const name = data.toString('utf8', sp + 1, nul);
    if (!name || name === '.' || name === '..' || name.includes('/')) return null;
    out.push({ mode, name, oid: data.toString('hex', nul + 1, nul + 1 + hashBytes) });
    off = nul + 1 + hashBytes;
  }
  return out;
}

// Flattening a tree touches one object per directory; a repository with more
// directories than this is not being drawn in a 50-row pane anyway, and the
// cap keeps a crafted deep tree from spending the draw budget.
const MAX_TREE_OBJECTS = 10_000;

/**
 * Flatten HEAD's tree to `path → { oid, mode }` — the "committed" side of the
 * staged comparison. Null when any needed object cannot be read (degrade,
 * never guess); an EMPTY map for an unborn branch, where nothing is committed
 * and every index entry really is staged.
 *
 * @param {string} gitDir
 * @returns {Map<string, { oid: string, mode: number }>|null}
 */
function readHeadTree(gitDir) {
  const head = resolveHead(gitDir);
  if (head === null) {
    // Distinguish "no commits yet" from "HEAD unreadable": an unborn HEAD still
    // has a well-formed symbolic ref line; garbage does not.
      const raw = readTextCapped(path.join(gitDir, 'HEAD'), 4096);
    if (raw !== null && /^ref:[ \t]*refs\//.test(raw.split('\n')[0].trim())) return new Map();
    return null;
  }
  const commit = readObject(gitDir, head);
  if (commit === null || commit.type !== 'commit') return null;
  const treeLine = /^tree ([0-9a-f]{40}|[0-9a-f]{64})$/m.exec(commit.data.toString('latin1', 0, Math.min(commit.data.length, 256)));
  if (!treeLine) return null;

  const hashBytes = treeLine[1].length / 2;
  /** @type {Map<string, { oid: string, mode: number }>} */
  const out = new Map();
  /** @type {Array<{ oid: string, prefix: string }>} */
  const queue = [{ oid: treeLine[1], prefix: '' }];
  let read = 0;
  while (queue.length > 0) {
    const { oid, prefix } = /** @type {{ oid: string, prefix: string }} */ (queue.shift());
    read += 1;
    if (read > MAX_TREE_OBJECTS) return null;
    const obj = readObject(gitDir, oid);
    if (obj === null || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data, hashBytes);
    if (entries === null) return null;
    for (const e of entries) {
      if ((e.mode & 0o170000) === 0o040000) {
        queue.push({ oid: e.oid, prefix: prefix + e.name + '/' });
      } else if ((e.mode & 0o170000) === 0o160000) {
        // A gitlink (submodule): recorded as committed content, never recursed.
        out.set(prefix + e.name, { oid: e.oid, mode: e.mode });
      } else {
        out.set(prefix + e.name, { oid: e.oid, mode: e.mode });
      }
    }
  }
  return out;
}

module.exports = {
  readObject, resolveRef, resolveHead, readHeadTree, parseTree, applyDelta,
  OBJECT_MAX_BYTES, MAX_DELTA_DEPTH,
};
