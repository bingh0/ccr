// @ts-check
'use strict';
// src/migrate.js — move a 0.3 ccr home to the 0.4 container layout, once,
// safely (features/instance-migration.feature).
//
// There is nothing to relocate but HISTORY: the only persistent content the
// 0.3 layout ever held was account burn history, misplaced inside profile
// dirs because the logger wrote to whatever the state dir was. So migration
// HARVESTS burnlogs to the container's top level, SWEEPS the profile dirs and
// the loose ephemeral droppings (a dead session's captured status, heartbeat,
// sentinel), and writes the ".layout" marker LAST — an interrupted migration
// is indistinguishable from one that has not started, and every move is
// move-if-present, so the next launch simply completes it.
//
// THE GENERAL SAFETY PROPERTY, ruled: if the source is not what migration
// expects, it STOPS AND CHANGES NOTHING. That is also the entire handling of
// an entry named "instances" or "profiles" (reserved by the new layout) and
// of a CCS profile literally named either — declined as real scope ("no other
// users will have this problem"); the stop makes it fail loudly for free.
//
// Runs AT LAUNCH ONLY. `ccr statusline` — invoked headlessly by Claude
// mid-session — never calls this. Removed at 1.0.0.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MARKER = '.layout';

// The 0.3 layout's loose per-session droppings — dead state the ephemeral
// rule says dies. Everything here may appear at the container root (bare
// launches) or inside a profile dir.
const DROPPINGS = ['last-status.json', 'launch-cwd', 'exited', 'sidecar-alive', 'slot-owner', 'view-request'];

const BURNLOG_RE = /^burnlog-[A-Za-z0-9_-]+\.jsonl$/;
// 0.4's own session join key (src/session-log.js). An upgrade while a session
// is open leaves the new statusline ticking against an unmigrated home, so
// these appear at the root BEFORE any launch migrates it — already at their
// final location, they are kept, not a surprise.
const SESSION_RE = /^session-[A-Za-z0-9_-]+\.jsonl$/;
// Same allow-list the launcher enforces for profile names.
const PROFILE_DIR_RE = /^[A-Za-z0-9._-]+$/;
// Names the new layout owns; their presence in an unmigrated home is exactly
// the surprise the safety property exists for.
const RESERVED = new Set(['instances', 'profiles']);

/**
 * Is a 0.3 session still running in this dir, as far as 0.3 state can say?
 * The published 0.3 recorded no owning pid, so the freshest signal it left is
 * the sidecar heartbeat. Refusing on a live heartbeat is the safe direction:
 * a false "live" delays migration by seconds; a false "dead" would harvest
 * burnlogs out from under a writing session.
 * @param {string} dir
 */
function legacyLive(dir) {
  try {
    if (fs.existsSync(path.join(dir, 'exited'))) return false;
    return require('./sidecar').sidecarAlive(dir);
  } catch { return false; }
}

/**
 * Move a burnlog to the container root, first-wins on a name collision (the
 * name carries the Claude session id, so a collision is the same session's
 * data twice — the copy already at the root is kept).
 * @param {string} from @param {string} rootDir @param {string} name
 */
function harvestBurnlog(from, rootDir, name) {
  const dest = path.join(rootDir, name);
  try {
    if (fs.existsSync(dest)) { fs.rmSync(from, { force: true }); return; }
    fs.renameSync(from, dest);
  } catch { /* best effort — a later launch completes it */ }
}

/**
 * Bring <home>/.ccr to the 0.4 layout. Total: never throws.
 *
 * @param {{ home?: string }} [opts]
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function ensureLayout(opts = {}) {
  const home = opts.home || os.homedir();
  const root = path.join(home, '.ccr');
  const marker = path.join(root, MARKER);

  try {
    if (!fs.existsSync(root)) {
      // Fresh install: create the container already migrated.
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      fs.writeFileSync(marker, '1\n', { mode: 0o600 });
      return { ok: true };
    }
    if (fs.existsSync(marker)) {
      sweepLegacyDroppings(root);
      return { ok: true };
    }

    // ---- Classify EVERYTHING before touching ANYTHING. ----
    /** @type {{ dir: string, name: string }[]} */
    const profileDirs = [];
    /** @type {string[]} */
    const looseBurnlogs = [];
    let rootHasDroppings = false;
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name);
      if (RESERVED.has(name)) return { ok: false, error: `ccr: cannot migrate ~/.ccr — unexpected entry '${name}' (reserved by the new layout); move it aside and relaunch` };
      if (name.startsWith('.')) continue;                      // dotted container entries are left alone
      if (BURNLOG_RE.test(name)) { looseBurnlogs.push(name); continue; }
      if (SESSION_RE.test(name)) continue;                     // 0.4 join key — already at its final home
      if (DROPPINGS.includes(name)) { rootHasDroppings = true; continue; }
      let st; try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isDirectory() && PROFILE_DIR_RE.test(name)) { profileDirs.push({ dir: p, name }); continue; }
      return { ok: false, error: `ccr: cannot migrate ~/.ccr — unexpected entry '${name}'; move it aside and relaunch` };
    }

    // A live 0.3 session anywhere refuses the whole migration, by name.
    if (legacyLive(root)) return { ok: false, error: 'ccr: cannot migrate ~/.ccr while a session is running there — close it first' };
    for (const { dir, name } of profileDirs) {
      if (legacyLive(dir)) return { ok: false, error: `ccr: cannot migrate ~/.ccr while an instance is running — close '${name}' first` };
    }

    // ---- Harvest, then sweep, then mark. ----
    for (const { dir } of profileDirs) {
      let names; try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) if (BURNLOG_RE.test(n)) harvestBurnlog(path.join(dir, n), root, n);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* next launch retries */ }
    }
    if (rootHasDroppings) for (const n of DROPPINGS) { try { fs.rmSync(path.join(root, n), { force: true }); } catch { /* best effort */ } }
    try { fs.chmodSync(root, 0o700); } catch { /* best effort */ }
    fs.writeFileSync(marker, '1\n', { mode: 0o600 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `ccr: migration failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * A DOWNGRADE-then-re-upgrade leaves a migrated container plus a 0.3 session's
 * loose droppings at the root — a dead instance's live state, which the
 * ephemeral rule says dies. Its burnlogs already live where the pool is, so
 * the day's history merges for free. Swept only once that session shows no
 * heartbeat (the safe direction, same as everywhere else).
 * @param {string} root
 */
function sweepLegacyDroppings(root) {
  try {
    if (!fs.existsSync(path.join(root, 'last-status.json'))
      && !fs.existsSync(path.join(root, 'sidecar-alive'))) return;
    if (legacyLive(root)) return;
    for (const n of DROPPINGS) { try { fs.rmSync(path.join(root, n), { force: true }); } catch { /* best effort */ } }
  } catch { /* best effort */ }
}

module.exports = { ensureLayout, MARKER };
