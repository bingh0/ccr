// @ts-check
'use strict';
// test/steps-design/_design-fixture.js — byte-level fixtures for the design
// tier: index files in versions 2, 3 and 4, and hand-assembled packfiles with
// both delta forms. These exist to state exactly which bytes the parsers are
// held to; test/git-working-tree.test.js separately holds the same parsers to
// what REAL git writes, so a fixture that drifted from git's own format would
// be caught from the far side.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { frame } = require('../steps/_git-fixture');

/** @param {Buffer|string} b */
const sha1raw = (b) => crypto.createHash('sha1').update(b).digest();

/**
 * Git's offset varint (decode_varint's inverse): 7 bits per byte, the value
 * gaining 1 before each shift. Used by index-v4 path compression and by
 * ofs-delta base distances.
 * @param {number} n
 * @returns {Buffer}
 */
function encodeOffsetVarint(n) {
  const bytes = [n & 0x7f];
  n = Math.floor(n / 128) - 1;
  while (n >= 0) {
    bytes.unshift(0x80 | (n & 0x7f));
    n = Math.floor(n / 128) - 1;
  }
  return Buffer.from(bytes);
}

/** The plain little-endian-grouped varint used for delta sizes. */
function encodeSizeVarint(/** @type {number} */ n) {
  const bytes = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return Buffer.from(bytes);
}

/**
 * Write an index file at an explicit version, with explicit entries — the
 * design tier's knob for stating "these bytes, this meaning".
 *
 * @param {string} gitDir
 * @param {2|3|4} version
 * @param {Array<{ path: string, oid: string, mode?: number, stage?: number,
 *   size?: number, mtimeSec?: number, extended?: boolean }>} entries
 * @param {{ truncateBy?: number, lieCount?: number }} [mangle]
 */
function writeIndexV(gitDir, version, entries, mangle = {}) {
  /** @type {Buffer[]} */
  const parts = [Buffer.alloc(12)];
  parts[0].write('DIRC', 0, 'latin1');
  parts[0].writeUInt32BE(version, 4);
  parts[0].writeUInt32BE(mangle.lieCount != null ? mangle.lieCount : entries.length, 8);
  let prevPath = '';
  for (const e of entries) {
    const hashBytes = e.oid.length / 2;
    const fixed = Buffer.alloc(40 + hashBytes + 2);
    const mt = e.mtimeSec || 1700000000;
    fixed.writeUInt32BE(mt, 0);
    fixed.writeUInt32BE(mt, 8);
    fixed.writeUInt32BE(e.mode == null ? 0o100644 : e.mode, 24);
    fixed.writeUInt32BE((e.size || 0) >>> 0, 36);
    Buffer.from(e.oid, 'hex').copy(fixed, 40);
    const pathBuf = Buffer.from(e.path, 'utf8');
    fixed.writeUInt16BE(
      ((e.stage || 0) << 12) | (e.extended ? 0x4000 : 0) | Math.min(pathBuf.length, 0xfff),
      40 + hashBytes);
    parts.push(fixed);
    if (e.extended) parts.push(Buffer.alloc(2)); // the v3 extended-flags word
    if (version === 4) {
      // Strip the whole previous path, then the full path as suffix — legal,
      // maximally explicit compression.
      parts.push(encodeOffsetVarint(prevPath.length), pathBuf, Buffer.from([0]));
    } else {
      const entryLen = fixed.length + (e.extended ? 2 : 0) + pathBuf.length + 1;
      const padded = Math.ceil(entryLen / 8) * 8;
      parts.push(pathBuf, Buffer.alloc(padded - entryLen + 1));
    }
    prevPath = e.path;
  }
  let body = Buffer.concat(parts);
  if (mangle.truncateBy) body = body.subarray(0, body.length - mangle.truncateBy);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'index'), Buffer.concat([body, sha1raw(body)]));
}

/**
 * One pack entry, pre-assembly.
 * @typedef {object} PackEntrySpec
 * @property {1|2|3|4|6|7} type  1 commit, 2 tree, 3 blob, 4 tag, 6 ofs-delta, 7 ref-delta.
 * @property {Buffer} data       Object bytes; for deltas, the DELTA bytes.
 * @property {string} oid        The id this entry resolves to (indexes the .idx).
 * @property {number} [baseIndex]  ofs-delta: which earlier entry is the base.
 * @property {string} [baseOid]    ref-delta: the base's id.
 */

/**
 * Assemble a .pack and its v2 .idx from entry specs, in order.
 * @param {string} gitDir
 * @param {PackEntrySpec[]} specs
 */
function writePack(gitDir, specs) {
  /** @type {Buffer[]} */
  const chunks = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(specs.length, 8);
  chunks.push(head);
  let at = 12;
  /** @type {number[]} */
  const offsets = [];
  for (const s of specs) {
    offsets.push(at);
    // Entry header: low 4 bits of size, 3 type bits, then 7-bit continuation.
    const size = s.data.length;
    const first = ((size > 15 ? 0x80 : 0)) | (s.type << 4) | (size & 0xf);
    const bytes = [first];
    let rest = Math.floor(size / 16);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest = Math.floor(rest / 128);
      if (rest > 0) b |= 0x80;
      bytes.push(b);
    }
    let header = Buffer.from(bytes);
    if (s.type === 6) {
      const base = offsets[/** @type {number} */ (s.baseIndex)];
      header = Buffer.concat([header, encodeOffsetVarint(at - base)]);
    } else if (s.type === 7) {
      header = Buffer.concat([header, Buffer.from(/** @type {string} */ (s.baseOid), 'hex')]);
    }
    const z = zlib.deflateSync(s.data);
    chunks.push(header, z);
    at += header.length + z.length;
  }
  const packBody = Buffer.concat(chunks);
  const packSha = sha1raw(packBody);
  const pack = Buffer.concat([packBody, packSha]);

  // The idx: magic, version, fanout, sorted hashes, CRCs (unchecked by the
  // reader, zeroed here), 4-byte offsets, the pack's trailer hash, own hash.
  const order = specs.map((s, i) => ({ s, i })).sort((a, b) => (a.s.oid < b.s.oid ? -1 : 1));
  const fanout = Buffer.alloc(256 * 4);
  for (let b = 0, c = 0; b < 256; b += 1) {
    while (c < order.length && parseInt(order[c].s.oid.slice(0, 2), 16) === b) c += 1;
    fanout.writeUInt32BE(c, b * 4);
  }
  const idxParts = [Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2]), fanout];
  for (const o of order) idxParts.push(Buffer.from(o.s.oid, 'hex'));
  idxParts.push(Buffer.alloc(order.length * 4)); // CRC table
  const offTable = Buffer.alloc(order.length * 4);
  order.forEach((o, i) => offTable.writeUInt32BE(offsets[o.i], i * 4));
  idxParts.push(offTable, packSha);
  const idxBody = Buffer.concat(idxParts);
  const idx = Buffer.concat([idxBody, sha1raw(idxBody)]);

  const dir = path.join(gitDir, 'objects', 'pack');
  fs.mkdirSync(dir, { recursive: true });
  const name = 'pack-' + packSha.toString('hex');
  fs.writeFileSync(path.join(dir, name + '.pack'), pack);
  fs.writeFileSync(path.join(dir, name + '.idx'), idx);
}

/**
 * A delta that rebuilds `target` from `base`: copy the whole base where the
 * two share their prefix, then insert the remainder. Enough to exercise both
 * instruction kinds without reimplementing xdelta.
 * @param {Buffer} base
 * @param {Buffer} target  Must start with `base`.
 */
function simpleDelta(base, target) {
  if (!target.subarray(0, base.length).equals(base)) throw new Error('fixture: target must extend base');
  const suffix = target.subarray(base.length);
  if (suffix.length > 127) throw new Error('fixture: suffix too long for one insert op');
  if (base.length === 0 || base.length > 0xffff) throw new Error('fixture: base size out of range');
  return Buffer.concat([
    encodeSizeVarint(base.length),
    encodeSizeVarint(target.length),
    // Copy: offset 0 (no offset bytes), one or two explicit size bytes.
    base.length > 0xff
      ? Buffer.from([0x80 | 0x10 | 0x20, base.length & 0xff, base.length >> 8])
      : Buffer.from([0x80 | 0x10, base.length]),
    Buffer.from([suffix.length]),
    suffix,
  ]);
}

module.exports = { writeIndexV, writePack, simpleDelta, encodeOffsetVarint, frame };
