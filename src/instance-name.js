// @ts-check
'use strict';
// src/instance-name.js — choose an instance's friendly name
// (features/instance-naming.feature). Identity is the slot number; the name
// is a label on top.
//
// THE MAPPING IS LOAD-BEARING FOR SECURITY, not cosmetics. The autoname
// derives from a directory name, `git clone` names the directory after the
// repo, and the name reaches the terminal title inside an OSC escape — and
// some terminals can echo the title back as terminal INPUT, so a repo named
// "; rm -rf ~" is plain ASCII that no control-byte blocklist touches.
// Constraining the CHARACTER SET is the guard (src/sanitize.js strips control
// bytes but is a blocklist; this is an allow-list). Nobody may relax it as
// cosmetic.
//
// The asymmetry, ruled: a DERIVED name is mapped (the user didn't choose
// it); an EXPLICIT name is rejected (they typed it, and a human is right
// there to fix it). Collision handling differs the same way: a derived name
// takes the lowest free suffix among LIVE names; an explicit collision is
// refused — silently suffixing it would make the address the user typed
// resolve to someone else's instance.

const path = require('node:path');
const fs = require('node:fs');

const NAME_CHAR_RE = /[A-Za-z0-9._-]/;
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const NAME_FILE = 'name';

/**
 * Map an arbitrary directory basename into the allowed set: anything outside
 * [A-Za-z0-9._-] becomes '-'. When the SOURCE had no legal character at all,
 * the slot number is the name (a dir named "---" keeps its dashes — they are
 * legal; a dir named "###" has nothing to keep).
 *
 * @param {string} source
 * @param {number} slot
 * @returns {string}
 */
function mapName(source, slot) {
  let kept = 0;
  const mapped = [...String(source)].map((c) => (NAME_CHAR_RE.test(c) ? (kept++, c) : '-')).join('');
  return kept > 0 ? mapped : String(slot);
}

/**
 * The autoname: the repository's directory name when the launch dir is inside
 * a repo (with the bare-repo `.git` correction the pane already applies),
 * else the launch dir's own basename — both through the mapping.
 *
 * @param {{ cwd: string, slot: number }} o
 * @returns {string}
 */
function deriveName(o) {
  let base = path.basename(o.cwd);
  try {
    const found = require('./git-repo').discoverRepo(o.cwd);
    if (found && found.found && found.root) {
      base = path.basename(found.root);
      if (base === '.git') base = path.basename(path.dirname(found.root));
    }
  } catch { /* fall back to the cwd basename */ }
  return mapName(base, o.slot);
}

/**
 * Names of the LIVE instances — the only set names must be unique within.
 * Ephemerality does the reaping: a dead instance's dir (and its name file)
 * is deleted, so its name is simply absent here.
 *
 * @param {{ home: string, inspect?: (dir: string) => {live: boolean, attached: boolean} }} o
 * @returns {Set<string>}
 */
function liveNames(o) {
  const inspect = o.inspect || require('./instance-slot').defaultInspect;
  const root = path.join(o.home, '.ccr', 'instances');
  /** @type {Set<string>} */
  const names = new Set();
  let entries; try { entries = fs.readdirSync(root); } catch { return names; }
  for (const n of entries) {
    if (!/^\d+$/.test(n)) continue;
    const dir = path.join(root, n);
    try {
      if (!inspect(dir).live) continue;
      const name = fs.readFileSync(path.join(dir, NAME_FILE), 'utf8').trim();
      if (name) names.add(name);
    } catch { /* unnamed or unreadable — nothing to reserve */ }
  }
  return names;
}

/**
 * The collision suffix: per-name lowest free among live names, INDEPENDENT of
 * the slot number — with "gitrepo" on slot 1 and "gatrepo" on slot 2, the next
 * gitrepo lands on slot 3 but is named "gitrepo2", never "gitrepo3". The
 * generator checks ALL live names, so a real directory named "gitrepo2"
 * cannot collide with a generated suffix.
 *
 * @param {string} base
 * @param {Set<string>} live
 * @returns {string}
 */
function withSuffix(base, live) {
  if (!live.has(base)) return base;
  for (let k = 2; ; k++) {
    const candidate = `${base}${k}`;
    if (!live.has(candidate)) return candidate;
  }
}

/**
 * Record the chosen name in the instance's own state — instance-scoped, so it
 * dies with the session, which is what frees the name.
 * @param {string} stateDir @param {string} name
 */
function recordName(stateDir, name) {
  try { fs.writeFileSync(path.join(stateDir, NAME_FILE), name + '\n', { mode: 0o600 }); } catch { /* best effort */ }
}

/**
 * The LIVE location half of the status-line identity: the repository's name
 * when `cwd` is inside one, else the directory's own basename — through the
 * same allow-list mapping as names (this string reaches the same terminal the
 * title does). Null when nothing legal survives or cwd is unusable: the
 * identity then shows the name alone.
 *
 * @param {string|undefined|null} cwd
 * @returns {string|null}
 */
function locationFrom(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  let base = path.basename(cwd);
  try {
    const found = require('./git-repo').discoverRepo(cwd);
    if (found && found.found && found.root) {
      base = path.basename(found.root);
      if (base === '.git') base = path.basename(path.dirname(found.root));
    }
  } catch { /* fall back to the basename */ }
  let kept = 0;
  const mapped = [...base].map((c) => (NAME_CHAR_RE.test(c) ? (kept++, c) : '-')).join('');
  return kept > 0 ? mapped : null;
}

/**
 * The terminal title: `[profile / ]name`, composed ONCE at launch and never
 * retitled — the title is the tab's ADDRESS (it must keep matching the name
 * -i accepts), while the pane and status line are the surfaces honest about
 * mid-session movement. Both inputs are already constrained (profile by the
 * launcher's allow-list, name by NAME_RE), so the title needs no escaping.
 *
 * @param {string|undefined} profile
 * @param {string} name
 * @returns {string}
 */
function composeTitle(profile, name) {
  return profile ? `${profile} / ${name}` : name;
}

/**
 * Everything an allocated slot needs to become a NAMED instance — shared by
 * all three launchers so no platform ships half-lit: derive (or take) the
 * name, record it and the profile in the instance dir, compose the title.
 * Explicit-name validation and the collision refusal happen BEFORE launch
 * routing (bin/ccr.js), so by the time a slot exists the name is legal.
 *
 * @param {{ slot: number, stateDir: string }} slot
 * @param {{ profile?: string, name?: string|null, cwd?: string, home?: string }} [o]
 * @returns {{ name: string, title: string }}
 */
function prepareInstance(slot, o = {}) {
  const home = o.home || require('node:os').homedir();
  const name = o.name != null ? o.name
    : withSuffix(deriveName({ cwd: o.cwd || process.cwd(), slot: slot.slot }), liveNames({ home }));
  recordName(slot.stateDir, name);
  if (o.profile) {
    try { fs.writeFileSync(path.join(slot.stateDir, 'profile'), o.profile + '\n', { mode: 0o600 }); } catch { /* best effort */ }
  }
  return { name, title: composeTitle(o.profile, name) };
}

module.exports = { NAME_RE, NAME_FILE, mapName, deriveName, liveNames, withSuffix, recordName, locationFrom, composeTitle, prepareInstance };
