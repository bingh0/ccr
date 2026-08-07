// @ts-check
'use strict';
// src/instance-resolve.js — find the instance you meant
// (features/instance-resolution.feature).
//
// The chain, ruled: -i (an explicit target typed NOW) → CCR_STATE_DIR (an
// explicit choice standing since launch; refused when it names the container
// — that is the old container/member confusion arriving by env var) → the
// live instance whose launch directory contains the cwd, longest match — a
// TIE is not "the" instance, so it falls through — → the single live one →
// else list them and refuse, offering -i, "because you have no idea what the
// user is looking for."
//
// Every caller heads its output with the resolved NAME — the safeguard that
// replaced bounding names by account: the mistake a user actually makes is
// reading the right panel about the wrong instance.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * @typedef {{ slot: number, stateDir: string, name: string|null, launchCwd: string|null }} LiveInstance
 */

/**
 * The live set — the only set names resolve against.
 * @param {{ home: string, inspect?: (dir: string) => {live: boolean, attached: boolean} }} o
 * @returns {LiveInstance[]}
 */
function listLive(o) {
  const inspect = o.inspect || require('./instance-slot').defaultInspect;
  const root = path.join(o.home, '.ccr', 'instances');
  /** @type {LiveInstance[]} */
  const out = [];
  let entries; try { entries = fs.readdirSync(root); } catch { return out; }
  for (const n of entries.sort((a, b) => Number(a) - Number(b))) {
    if (!/^\d+$/.test(n)) continue;
    const dir = path.join(root, n);
    try {
      if (!inspect(dir).live) continue;
      const read = (/** @type {string} */ f) => {
        try { return fs.readFileSync(path.join(dir, f), 'utf8').trim() || null; } catch { return null; }
      };
      out.push({ slot: Number(n), stateDir: dir, name: read('name'), launchCwd: read('launch-cwd') });
    } catch { /* skip unreadable */ }
  }
  return out;
}

/** @param {LiveInstance[]} live @param {string} cmd */
function listAndRefuse(live, cmd) {
  const lines = ['ccr: several live instances match — say which:'];
  for (const i of live) lines.push(`  ${i.name || `slot ${i.slot}`}`);
  lines.push(`try: ccr ${cmd} -i <name>`);
  return { ok: /** @type {false} */ (false), error: lines.join('\n') };
}

/**
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, cwd?: string, target?: string|null,
 *   command?: string, inspect?: (dir: string) => {live: boolean, attached: boolean} }} [o]
 * @returns {{ ok: true, stateDir: string, name: string|null } | { ok: false, error: string, none?: boolean }}
 */
function resolveInstance(o = {}) {
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const cmd = o.command || 'economy';

  const live = listLive({ home, inspect: o.inspect });

  // 1. An explicit -i target, from the live set only. A typo matches nothing
  // and errors — it reaches something else only by landing exactly on another
  // live name.
  if (o.target != null) {
    const hit = live.find((i) => i.name === o.target);
    if (!hit) return { ok: false, error: `ccr: no live instance named '${o.target}'` };
    return { ok: true, stateDir: hit.stateDir, name: hit.name };
  }

  // 2. An explicit state dir standing since launch — unless it names the
  // container itself.
  if (env.CCR_STATE_DIR) {
    const dir = path.resolve(env.CCR_STATE_DIR);
    const container = path.resolve(home, '.ccr');
    if (dir === container || dir === path.join(container, 'instances')) {
      return { ok: false, error: 'ccr: the ccr home is a container, not an instance — point CCR_STATE_DIR at an instance dir or use -i' };
    }
    let name = null;
    try { name = fs.readFileSync(path.join(dir, 'name'), 'utf8').trim() || null; } catch { /* unnamed */ }
    return { ok: true, stateDir: dir, name };
  }

  // 3. Launch-directory containment, longest match; a tie falls through.
  const here = path.resolve(cwd);
  const containing = live.filter((i) => {
    if (!i.launchCwd) return false;
    const base = path.resolve(i.launchCwd);
    return here === base || here.startsWith(base + path.sep);
  });
  if (containing.length) {
    const longest = Math.max(...containing.map((i) => path.resolve(String(i.launchCwd)).length));
    const best = containing.filter((i) => path.resolve(String(i.launchCwd)).length === longest);
    if (best.length === 1) return { ok: true, stateDir: best[0].stateDir, name: best[0].name };
    return listAndRefuse(best, cmd);
  }

  // 4. The single live one is unambiguous from anywhere.
  if (live.length === 1) return { ok: true, stateDir: live[0].stateDir, name: live[0].name };
  if (live.length === 0) return { ok: false, none: true, error: 'ccr: no live instance — run `ccr` to launch one' };

  // 5. Several candidates, no signal.
  return listAndRefuse(live, cmd);
}

module.exports = { resolveInstance, listLive };
