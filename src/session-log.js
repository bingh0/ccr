// @ts-check
'use strict';
// src/session-log.js — the forensic join key and history retention
// (features/instance-persistence.feature).
//
// One file per session, `session-<sid>.jsonl`, at the container's top level
// beside `burnlog-<sid>.jsonl` — same key, same lifecycle. TWO-PHASE, ruled
// on the owner's words ("even partial information allows forensic
// reconstruction of what happened"): the open record is written the moment
// the session id first exists — deaths are exactly when writes cannot be
// trusted to happen — and finalized by whoever sees the death: the exiting
// process (`ended`) if polite, the sweep (`swept`, stamped with the last
// heartbeat's mtime — the honest "ended around here") if not. A `swept`
// marker is itself forensic signal: this session died badly.
//
// The join key gets its OWN file, never a line inside the burnlog: the
// burnlog's size cap halves that file by DROPPING THE HEAD
// (src/instrument.js capFile), which would silently destroy a head-of-file
// key at 2MB.
//
// RETENTION, ruled shape-independent: content survives 30 full days after
// its session ends and is gone at 31, counted from last write — and with
// per-session files, last write IS death (the finalize marker), so file-age
// pruning needs no date parsing.

const fs = require('node:fs');
const path = require('node:path');

const RETAIN_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {string} sid */
const clean = (sid) => String(sid || '').replace(/[^A-Za-z0-9_-]/g, '');

/** @param {string} home @param {string} sid */
function logFile(home, sid) {
  return path.join(home, '.ccr', `session-${clean(sid)}.jsonl`);
}

/**
 * Phase one: the open record, written once, at the first status capture.
 * @param {string} home
 * @param {string} sid
 * @param {{ name?: string|null, profile?: string|null, launch_cwd?: string|null, now?: number }} fields
 */
function openEntry(home, sid, fields = {}) {
  if (!clean(sid)) return;
  const file = logFile(home, sid);
  try {
    if (fs.existsSync(file)) return;
    const rec = {
      session_id: clean(sid),
      name: fields.name || null,
      profile: fields.profile || null,
      launch_cwd: fields.launch_cwd || null,
      started: fields.now != null ? fields.now : Date.now(),
    };
    fs.writeFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
  } catch { /* best effort — forensics must never break the status line */ }
}

/**
 * Phase two: whoever sees the death appends the marker.
 * @param {string} home
 * @param {string} sid
 * @param {{ ended?: number, swept?: number }} marker
 */
function finalize(home, sid, marker) {
  if (!clean(sid)) return;
  const file = logFile(home, sid);
  try {
    if (!fs.existsSync(file)) return; // died before the first tick — nothing to finalize
    fs.appendFileSync(file, JSON.stringify(marker) + '\n');
  } catch { /* best effort */ }
}

/**
 * Finalize on behalf of an instance dir about to be deleted: the dir's own
 * captured status is what still knows the session id.
 * @param {string} home
 * @param {string} dir the instance's state dir
 * @param {'ended'|'swept'} how
 * @param {number} [at]
 */
function finalizeFromDir(home, dir, how, at) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'last-status.json'), 'utf8');
    const sid = JSON.parse(raw).session_id;
    if (!sid) return;
    finalize(home, sid, { [how]: at != null ? at : Date.now() });
  } catch { /* no capture — the accepted gap: nothing to join, nothing to debug */ }
}

/**
 * The 31-day boundary: history is kept through 30 full days after its
 * session's end and gone at 31 — burnlogs and session logs alike, whole
 * files, by last-write mtime.
 * @param {string} home
 * @param {{ now?: number }} [opts]
 */
function pruneHistory(home, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const root = path.join(home, '.ccr');
  let names; try { names = fs.readdirSync(root); } catch { return; }
  for (const n of names) {
    if (!/^(burnlog|session)-[A-Za-z0-9_-]+\.jsonl$/.test(n)) continue;
    const p = path.join(root, n);
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs >= RETAIN_DAYS * DAY_MS) fs.rmSync(p, { force: true });
    } catch { /* best effort */ }
  }
}

module.exports = { openEntry, finalize, finalizeFromDir, pruneHistory, logFile, RETAIN_DAYS };
