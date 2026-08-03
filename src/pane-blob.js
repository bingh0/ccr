// @ts-check
'use strict';
// src/pane-blob.js — THE verifier. Between a blob file's bytes and any renderer
// sits exactly this function, and it returns either a validated v1 blob or one
// named failure. No renderer ever sees unvalidated input.
// Contract: docs/PANE-CONTRACT.md § The verifier.
//
// Three properties this file is built around, all of them load-bearing:
//
//   TOTAL. Nothing here throws. The sidebar is ONE pane: an exception raised
//   into the draw loop would take the burn-rate display down with it, so a
//   malformed blob must cost a pane state and never the sidecar.
//
//   WHITELIST-CONSTRUCT. Every returned object is built fresh from the fields
//   v1 names. The parsed input is never spread, never Object.assign'd, never
//   merged. That is the prototype-pollution path, and it is the one
//   injection-style attack a JSON consumer in Node gets handed for free.
//
//   TYPES CHECKED, NOT COERCED. A JSON file chooses its own value types, so
//   `typeof` is the only thing that makes "this field is a string" true. (The
//   sidecar learned this the hard way elsewhere: an array where a string was
//   expected put raw terminal escapes on screen. See src/sanitize.js.)

const fs = require('node:fs');
const { stripControl } = require('./sanitize');

const BLOB_VERSION = 1;
const MAX_BLOB_BYTES = 256 * 1024;
const MAX_ROWS = 256;
const MAX_FIELD_CHARS = 512;
const MAX_SPARK = 32;

/** The closed row-status enum. Anything else renders as `dark` (never green). */
const ROW_STATUSES = new Set(['ok', 'warn', 'alert', 'dark', 'off']);

/**
 * A display string: sanitized, then truncated. Order matters — validation
 * checks shape, never bytes, so the strip is unconditional and comes after.
 * @param {string} s
 * @returns {string}
 */
const display = (s) => {
  const clean = String(stripControl(s) ?? '');
  return clean.length > MAX_FIELD_CHARS ? clean.slice(0, MAX_FIELD_CHARS) : clean;
};

const isStr = (/** @type {any} */ v) => typeof v === 'string';

/**
 * Read the blob file safely enough to name WHY it could not be read.
 *
 * This does not use readTextCapped: that collapses every failure to null, and
 * the contract requires "cannot-read" (a chmod mistake, a fifo, a symlink) to
 * be visibly distinct from "waiting" (the producer simply hasn't run yet).
 * Conflating them would make a permissions bug look like patience.
 *
 * @param {string} file
 * @returns {{ ok: true, text: string, mtimeMs: number }
 *           | { ok: false, state: 'waiting' }
 *           | { ok: false, state: 'cannot-read', reason: string }
 *           | { ok: false, state: 'oversized' }}
 */
function readBlobFile(file) {
  let st;
  try {
    // lstat, not stat: a symlink must be REFUSED rather than followed, and a
    // fifo must be identified without opening it (opening one blocks forever).
    st = fs.lstatSync(file);
  } catch (e) {
    const code = e && /** @type {any} */ (e).code;
    if (code === 'ENOENT') return { ok: false, state: 'waiting' };
    return { ok: false, state: 'cannot-read', reason: code === 'EACCES' ? 'permission' : 'unavailable' };
  }
  if (st.isSymbolicLink()) return { ok: false, state: 'cannot-read', reason: 'symlink' };
  if (st.isDirectory()) return { ok: false, state: 'cannot-read', reason: 'directory' };
  if (!st.isFile()) return { ok: false, state: 'cannot-read', reason: 'not a regular file' };
  if (st.size > MAX_BLOB_BYTES) return { ok: false, state: 'oversized' };

  // The lstat above is ADVISORY, not a guarantee: the path can be replaced
  // between the check and the open, and a producer that writes atomically is
  // renaming over this path constantly, so a swap looks like normal operation.
  // The open itself must therefore be safe on its own terms:
  //   O_NOFOLLOW  — refuse a symlink at open time, so "symlinks are refused"
  //                 is enforced by the kernel rather than by a stale stat.
  //   O_NONBLOCK  — a FIFO opened for reading blocks until a writer appears,
  //                 which in this single-threaded draw loop means FOREVER: no
  //                 render, no heartbeat, no recovery. With O_NONBLOCK the open
  //                 returns immediately (ENXIO) instead of hanging.
  // Both flags are absent on Windows; `|| 0` degrades to the old behaviour
  // there, where neither fifos nor symlinks-without-privilege are a concern.
  const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
  const O_NONBLOCK = fs.constants.O_NONBLOCK || 0;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    const code = e && /** @type {any} */ (e).code;
    if (code === 'ELOOP') return { ok: false, state: 'cannot-read', reason: 'symlink' };
    if (code === 'ENXIO' || code === 'EWOULDBLOCK' || code === 'EAGAIN') {
      return { ok: false, state: 'cannot-read', reason: 'not a regular file' };
    }
    if (code === 'ENOENT') return { ok: false, state: 'waiting' };
    return { ok: false, state: 'cannot-read', reason: code === 'EACCES' ? 'permission' : 'unavailable' };
  }
  try {
    // Re-stat from the descriptor: the file may have been replaced since the
    // lstat, and this describes the bytes actually held open.
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) return { ok: false, state: 'cannot-read', reason: 'not a regular file' };
    if (fst.size > MAX_BLOB_BYTES) return { ok: false, state: 'oversized' };
    const buf = Buffer.alloc(Math.min(fst.size, MAX_BLOB_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return { ok: true, text: buf.subarray(0, n).toString('utf8'), mtimeMs: fst.mtimeMs };
  } catch {
    return { ok: false, state: 'cannot-read', reason: 'unavailable' };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Validate one row. Returns null when the row itself is malformed (which makes
 * the whole blob invalid — a row without a value is a shape violation, not a
 * decoration). An UNRECOGNIZED status is not a violation: it renders as `dark`,
 * because a producer naming a state ccr doesn't know must never come out green.
 * @param {any} r
 * @returns {{ label: string, value: string, status: string, detail: string|null, spark: number[]|null }|null}
 */
function validateRow(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (!isStr(r.label) || !isStr(r.value) || !isStr(r.status)) return null;

  // Spark is DECORATION, so it degrades locally: a non-conforming spark drops
  // the sparkline and keeps the row. Ruled 2026-08-02 — a decoration never
  // costs more than itself, the same principle as clamping an overlong field.
  /** @type {number[]|null} */
  let spark = null;
  if (Array.isArray(r.spark) && r.spark.length && r.spark.length <= MAX_SPARK
    && r.spark.every((/** @type {any} */ n) => typeof n === 'number' && Number.isFinite(n))) {
    spark = r.spark.slice();
  }

  return {
    label: display(r.label),
    value: display(r.value),
    status: ROW_STATUSES.has(r.status) ? r.status : 'dark',
    detail: isStr(r.detail) ? display(r.detail) : null,
    spark,
  };
}

/**
 * Turn a parsed blob into a validated v1 blob, or name the single failure.
 * Split out from the file read so it is directly testable and so the render
 * path can never reach a shape that skipped it.
 * @param {any} input
 * @returns {{ state: 'ok', blob: any } | { state: 'invalid' }
 *           | { state: 'unsupported', version: number|null } | { state: 'oversized-rows' }}
 */
function validateBlob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { state: 'invalid' };

  // Version first: an unrecognized `v` is its own named state, so it must be
  // decided before any other field can call the blob "invalid".
  if (!Number.isInteger(input.v)) return { state: 'invalid' };
  if (input.v !== BLOB_VERSION) return { state: 'unsupported', version: input.v };

  if (!isStr(input.tool) || !isStr(input.title) || !isStr(input.status)) return { state: 'invalid' };
  if (input.status !== 'ok' && input.status !== 'broken') return { state: 'invalid' };

  const basis = input.basis;
  if (!basis || typeof basis !== 'object' || Array.isArray(basis)) return { state: 'invalid' };
  if (!isStr(basis.label) || !isStr(basis.at)) return { state: 'invalid' };

  // A broken blob must carry a non-empty message. Without one it would render
  // as a failure with nothing to say, which is indistinguishable from a bug in
  // ccr — so it is invalid rather than a silent half-render.
  const broken = input.status === 'broken';
  if (broken && !(isStr(input.message) && input.message.trim())) return { state: 'invalid' };

  if (!Array.isArray(input.rows)) return { state: 'invalid' };
  if (input.rows.length > MAX_ROWS) return { state: 'oversized-rows' };

  /** @type {any[]} */
  const rows = [];
  // A broken blob's rows are IGNORED per the contract — not validated, not
  // rendered. Validating them anyway would let a stray row turn a producer's
  // honest failure report into "invalid", burying the message it exists to show.
  if (!broken) {
    for (const r of input.rows) {
      const row = validateRow(r);
      if (!row) return { state: 'invalid' };
      rows.push(row);
    }
  }

  return {
    state: 'ok',
    blob: {
      v: BLOB_VERSION,
      tool: display(input.tool),
      title: display(input.title),
      status: input.status,
      basis: { label: display(basis.label), at: display(basis.at) },
      message: isStr(input.message) ? display(input.message) : null,
      rows,
    },
  };
}

/**
 * The whole pipeline for one configured pane, once per tick.
 * @param {string} file absolute path from config
 * @param {{ now?: number }} [opts]
 * @returns {{ state: string, blob?: any, version?: number|null, reason?: string, ageMs?: number }}
 */
function loadPaneBlob(file, opts = {}) {
  const read = readBlobFile(file);
  if (!read.ok) {
    // `strict` is off in jsconfig.json, and without strictNullChecks TypeScript
    // will not narrow this union by its boolean `ok` discriminant — the whole
    // union survives into this branch. So name the failure shape once here
    // instead of re-testing it at runtime: the runtime predicate stays `ok`,
    // which is the property readBlobFile actually guarantees, and this replaces
    // the `any` cast that was already covering the same gap for `reason`.
    const fail = /** @type {{ ok: false, state: string, reason?: string }} */ (read);
    return fail.state === 'cannot-read'
      ? { state: 'cannot-read', reason: fail.reason }
      : { state: fail.state };
  }
  if (!read.text.trim()) return { state: 'waiting' };

  let parsed;
  try { parsed = JSON.parse(read.text); } catch { return { state: 'unreadable' }; }

  const now = opts.now != null ? opts.now : Date.now();
  const ageMs = Math.max(0, now - read.mtimeMs);

  const v = validateBlob(parsed);
  if (v.state === 'ok') return { state: 'ok', blob: v.blob, ageMs };
  if (v.state === 'unsupported') return { state: 'unsupported', version: v.version, ageMs };
  if (v.state === 'oversized-rows') return { state: 'oversized', ageMs };
  return { state: 'invalid', ageMs };
}

module.exports = {
  loadPaneBlob, validateBlob, readBlobFile,
  BLOB_VERSION, MAX_BLOB_BYTES, MAX_ROWS, MAX_FIELD_CHARS, MAX_SPARK, ROW_STATUSES,
};
