// @ts-check
'use strict';
// src/instance-slot.js — choose the state dir + session name for a BARE `ccr`,
// so opening a second terminal and typing `ccr` just works.
//
// THE PROBLEM. Bare `ccr` used to hardcode all three of its namespaces: session
// "ccr", tmux socket "ccr", state dir ~/.ccr. A second bare launch therefore
//   1. ran the launcher's "clean re-launch" kill-session against the FIRST
//      instance's session, tearing down a live Claude in another terminal;
//   2. shared last-status.json and the `exited` sentinel, so each sidebar showed
//      whichever session ticked last, and quitting one flipped the other to
//      "session ended";
//   3. collided on the sidecar-alive heartbeat, whose newer-wins rule then stood
//      the first sidebar down.
// Passing a CCS profile avoided all three by deriving a per-profile namespace —
// but that requires CCS, which a plain Claude Code user does not have.
//
// THE FIX (0.4.0 layout — features/instance-lifecycle.feature). EVERY launch,
// bare or profiled, takes the lowest FREE slot: state dir ~/.ccr/instances/<n>,
// session "ccr" for slot 1 (the historical session name) and "ccr-<n>" above.
// ~/.ccr itself is a CONTAINER now, never a state dir — the old root cause was
// a path that was simultaneously the container for all instances and instance
// 1's own state dir, which no guard or scan could treat uniformly. Profiles
// slot too: their old per-profile namespace ("ccr-<profile>") meant two
// launches of the SAME profile collided exactly the way two bare launches did.
// scripts/launch.sh needs no change at all: it already derives session, socket
// and state dir from CCR_SESSION / CCR_STATE_DIR, so handing it those two
// values namespaces the whole instance.
//
// Instances are EPHEMERAL: a polite exit deletes the instance dir (unless a
// sidebar is still attached — a live process reading the dir is never deleted
// under; the sweep collects the dir once that process is gone too), and each
// launch sweeps dirs whose recorded process no longer exists. The sidecar
// heartbeat's staleness is DISPLAY-ONLY and never a deletion trigger: suspend,
// swap and Ctrl-Z all silence a live session's heartbeat for far longer than
// its 5s window (src/sidecar.js), and deleting a running session's state dir
// is the one unrecoverable mistake here. Deletion needs a dead process.
//
// WHO OWNS A SLOT is the part that has to be exactly right, because getting it
// wrong hands a second launch the namespace of a session that is still running —
// which is bug (1) above, the very thing this module exists to prevent.
//
// The owner is THE LAUNCHER PROCESS, recorded as a pid in <stateDir>/slot-owner.
// That is the only signal that tracks the SESSION rather than some artifact of
// it: `ccr` blocks for the session's whole lifetime on both hosts that matter
// (tmux, where launch.sh ends in `tmux attach`; and VS Code, where it spawns
// Claude in the current pane), so "is that pid alive" is exactly "is that
// session running". An earlier draft used the sidebar's heartbeat instead, and
// closing or crashing the sidebar pane then freed a slot out from under a live
// Claude — the heartbeat tracks the SIDEBAR, which is a different question.
//
// Two signals, not one, because neither alone is total:
//
//   owner pid alive                  → LIVE. Covers a session whose sidebar was
//                                      closed, and every pre-sidebar moment of
//                                      startup, with no timing window at all.
//   heartbeat fresh, no `exited`     → LIVE. Covers a session whose launcher is
//                                      gone but which is still running: a
//                                      detached tmux client, and native Windows,
//                                      where the launcher exits once wt.exe has
//                                      the window.
//   heartbeat fresh, `exited` present→ ATTACHED. The session is over but its
//                                      sidebar is still up. Free to take, and
//                                      the caller is TOLD, because the VS Code
//                                      sidebar deliberately outlives its session
//                                      to pick the next one up — skipping to
//                                      another slot would strand that pane and
//                                      re-break the duplicate-pane fix.
//   otherwise                        → FREE.
//
// RESERVING is an exclusive create of the owner file, uniformly — a free slot
// and an attached one alike. An earlier draft skipped the exclusive create when
// reusing an attached slot, and since a stale `exited` sentinel outlives every
// normal session (launch.sh writes it on exit and only the NEXT launch clears
// it), two launchers starting together both read "attached" and both took the
// same slot. Reserving always, and never inferring ownership from a file the
// previous session left behind, is what closes that.
//
// The heartbeat is left strictly alone here: it belongs to the sidecar, and
// writing a newer nonce into it is precisely what makes a live sidebar stand
// down (see heartbeatTick in src/sidecar.js).
//
// A crashed launcher leaves a stale owner file, which the next probe clears
// because its pid is gone — so slots are REUSED rather than minted, and
// relaunching after a crash lands back on slot 1 instead of drifting to
// instances/47. A recycled pid can only make a slot look BUSY, never free, so the
// worst it costs is a slot number.
//
// KNOWN LIMITS, none of them worse than the behavior that predated slots:
//   - Native Windows has no owning process — the launcher returns as soon as
//     wt.exe owns the window — so there a slot is unguarded until pane 1's
//     sidecar starts beating, about a second.
//   - The check that a slot's directory is real (defaultDirUsable) narrows a
//     symlink swap rather than sealing it; Node exposes no openat/O_NOFOLLOW to
//     do better, and the attacker there is already running as the user.
//   - A same-uid process that plants `exited` beside a live session's heartbeat
//     can make that slot look ATTACHED once the owning launcher is gone (a
//     detached tmux session). It could equally kill-session that instance
//     outright, so this grants nothing new.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ensureSecureDir } = require('./state-dir');

// The live-instance cap, and it is not arbitrary: cross-instance meter
// reconciliation caps sibling merges at MAX_PROFILES=32 (src/account-limits.js),
// so a 33rd live instance would silently under-report the shared 5h/weekly
// meters — and WHICH 32 win would be readdir order. The 33rd launch is refused
// instead of falling back to a shared namespace: the old fallback target was
// the container itself, and sharing it was the reported bug.
const MAX_SLOTS = 32;

// Bounds every directory walk under the container, so a pathological state dir
// cannot spin the launcher. Mirrors MAX_SCAN_ENTRIES in src/account-limits.js.
const MAX_SWEEP_ENTRIES = 512;

// Holds the launcher's "<pid>:<startedMs>". Deliberately NOT the heartbeat file:
// that one is the sidecar's, and answers a different question (see the header).
const OWNER_FILE = 'slot-owner';

/**
 * Where slot `n` lives: ~/.ccr/instances/<n>, uniformly — the container/member
 * split that is the whole point of the 0.4.0 layout. Slot 1 keeps the
 * historical SESSION name "ccr" (so `tmux -L ccr attach` still works for a
 * lone instance) but its state dir is a member like every other slot's.
 *
 * @param {number} n
 * @param {string} home
 * @returns {{ slot: number, session: string, stateDir: string }}
 */
function slotPaths(n, home) {
  return {
    slot: n,
    session: n === 1 ? 'ccr' : `ccr-${n}`,
    stateDir: path.join(home, '.ccr', 'instances', String(n)),
  };
}

/**
 * The pid recorded in a slot's owner file, or null when there isn't one.
 * @param {string} dir
 * @returns {number | null}
 */
function ownerPid(dir) {
  try {
    const m = /^(\d+):/.exec(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8').trim());
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Does that process still exist? Signal 0 checks without delivering anything.
 * EPERM means it exists under another uid — alive for our purposes, and the
 * safe answer either way, since a false "alive" only costs a slot number while a
 * false "dead" would hand this slot to a second session.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/**
 * Classify a slot. See the header for why it takes two signals.
 *
 * @param {string} dir
 * @returns {{ live: boolean, attached: boolean }} `live` bars the slot;
 *   `attached` means a sidebar is waiting there to be reused rather than
 *   re-split.
 */
function defaultInspect(dir) {
  const pid = ownerPid(dir);
  if (pid !== null && pidAlive(pid)) return { live: true, attached: false };
  // Lazy require: keeps the render stack off the launch path, and single-sources
  // the heartbeat's freshness window in src/sidecar.js.
  if (!require('./sidecar').sidecarAlive(dir)) return { live: false, attached: false };
  let ended = false;
  try { fs.statSync(path.join(dir, 'exited')); ended = true; } catch { /* still running */ }
  return { live: !ended, attached: ended };
}

/**
 * Take ownership of a slot the caller has already found free. Returns false only
 * when another launcher got there first, which is what makes the probe
 * race-free: the loser moves on to the next slot.
 *
 * @param {string} dir
 * @returns {boolean} true when the slot is ours
 */
function defaultReserve(dir) {
  const file = path.join(dir, OWNER_FILE);
  const pid = ownerPid(dir);
  if (pid === null || !pidAlive(pid)) {
    // A launcher that is gone: clear its record so the create below can succeed,
    // or the first crash would retire this slot for good. rmSync does not follow
    // a symlink — it removes the link itself — so this cannot reach outside.
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
  try {
    // 'wx' is O_CREAT|O_EXCL: it fails if anything already occupies the path,
    // including a symlink (even a dangling one), so this can never write through
    // a planted link, and two launchers cannot both create it.
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeSync(fd, `${process.pid}:${Date.now()}`); } finally { fs.closeSync(fd); }
    return true;
  } catch {
    return false;
  }
}

/**
 * Give a slot back when the session ends. Purely an optimisation — the pid check
 * already reclaims a slot whose launcher is gone — so it only ever removes a
 * record that is still OURS, and never fails loudly.
 *
 * @param {string} dir
 */
function releaseSlot(dir) {
  try {
    if (ownerPid(dir) === process.pid) fs.rmSync(path.join(dir, OWNER_FILE), { force: true });
  } catch { /* best effort */ }
}

/**
 * Is this numbered slot's directory safe to use? ccr picks these paths with no
 * user input, so an attacker who plants a symlink at ~/.ccr/<n> would otherwise
 * redirect a whole instance's state — `mkdirSync` succeeds on a symlink to a
 * directory and `chmodSync` follows it, so ensureSecureDir would chmod 0700 and
 * write into wherever it points. An existing entry must therefore be a real
 * directory. Every slot is checked uniformly — under the 0.4.0 layout slot 1
 * is an ordinary member of instances/ like any other.
 *
 * This narrows the window rather than sealing it: a same-uid process can still
 * swap the directory between this check and the writes that follow. Node has no
 * openat/O_NOFOLLOW to close that properly.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function defaultDirUsable(dir) {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory();
  } catch {
    return true; // absent — ensureDir will create it
  }
}

/**
 * Fill in real-environment implementations for anything the caller didn't
 * inject, so allocateSlot's decision logic can be unit-tested with pure
 * stand-ins. Mirrors the withDefaults pattern in launch-win.js.
 *
 * @param {Partial<Deps>} deps
 * @returns {Deps}
 */
function withDefaults(deps) {
  const home = deps.home || os.homedir();
  return {
    env: deps.env || process.env,
    home,
    inspect: deps.inspect || defaultInspect,
    reserve: deps.reserve || defaultReserve,
    dirUsable: deps.dirUsable || defaultDirUsable,
    ensureDir: deps.ensureDir || ensureSecureDir,
    removeDir: deps.removeDir
      || ((/** @type {string} */ dir) => { fs.rmSync(dir, { recursive: true, force: true }); }),
    listDir: deps.listDir
      || ((/** @type {string} */ dir) => { try { return fs.readdirSync(dir); } catch { return []; } }),
  };
}

/**
 * Delete dead instances' directories — disk housekeeping, demoted by ruling
 * from any correctness role (features/instance-lifecycle.feature: "A quiet
 * heartbeat alone never triggers deletion"). A dir goes only when its recorded
 * process no longer exists AND no sidebar is attached: `inspect` already
 * answers both, and an ATTACHED dir (session over, sidebar waiting to be
 * reused) is skipped because a live process is still reading it — it is
 * collected on a later sweep, once that sidebar is gone too.
 *
 * Scoped hard: only numeric entries directly under <home>/.ccr/instances, and
 * never through a symlink — everything here runs as the user against paths the
 * user did not type. A dir written to in the last minute is skipped (minAgeMs):
 * on native Windows the launcher exits once wt.exe owns the window, so a
 * starting instance has no owner pid and no heartbeat for about a second, and
 * an idle session whose sidebar was closed has neither signal at all — its
 * status captures keep the dir's mtime moving while it renders, and declining
 * to delete a recently-written dir is the safe direction either way.
 *
 * @param {Partial<Deps> & { minAgeMs?: number, now?: number }} [opts]
 * @returns {number} how many instance dirs were removed
 */
function sweepDeadInstances(opts = {}) {
  const d = withDefaults(opts);
  const root = path.join(d.home, '.ccr', 'instances');
  const minAge = opts.minAgeMs != null ? opts.minAgeMs : 60_000;
  const now = opts.now != null ? opts.now : Date.now();
  let removed = 0, seen = 0;
  for (const name of d.listDir(root)) {
    if (++seen > MAX_SWEEP_ENTRIES) break;
    if (!/^\d+$/.test(name)) continue;
    const dir = path.join(root, name);
    let st;
    try { st = fs.lstatSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    // minAge 0 disables the guard outright: a freshly written file's mtime can
    // land a sub-millisecond AFTER Date.now() (filesystem timestamp rounding),
    // so `now - mtime < 0` would silently re-enable the skip.
    if (minAge > 0 && now - st.mtimeMs < minAge) continue;
    const { live, attached } = d.inspect(dir);
    if (live || attached) continue;
    // The sweep finalizes the dead instance's join key on its behalf before
    // deleting — `swept`, stamped with the last heartbeat's mtime, the honest
    // "ended around here" (src/session-log.js).
    let at = st.mtimeMs;
    try { at = fs.lstatSync(path.join(dir, 'sidecar-alive')).mtimeMs; } catch { /* no heartbeat left */ }
    try { require('./session-log').finalizeFromDir(d.home, dir, 'swept', at); } catch { /* best effort */ }
    try { d.removeDir(dir); removed += 1; } catch { /* best effort */ }
  }
  return removed;
}

/**
 * End-of-session cleanup: instances are ephemeral, so a polite exit deletes
 * the whole instance dir (features/instance-lifecycle.feature: "Exiting
 * politely deletes the instance") — UNLESS a sidebar is still attached, which
 * is a live process reading the dir; then only the slot reservation is
 * released and the dir survives for reuse, to be swept once the sidebar too
 * is gone. Never touches anything outside <home>/.ccr/instances.
 *
 * @param {string} dir the instance's state dir
 * @param {Partial<Deps> & { sidecarAlive?: (dir: string) => boolean }} [opts]
 */
function retireInstance(dir, opts = {}) {
  const d = withDefaults(opts);
  const root = path.resolve(d.home, '.ccr', 'instances') + path.sep;
  const alive = opts.sidecarAlive || ((/** @type {string} */ s) => require('./sidecar').sidecarAlive(s));
  try {
    if (!path.resolve(dir).startsWith(root)) { releaseSlot(dir); return; }
    // The polite exit finalizes its own join key (src/session-log.js) —
    // whether or not an attached sidebar keeps the dir alive for reuse.
    try { require('./session-log').finalizeFromDir(d.home, dir, 'ended'); } catch { /* best effort */ }
    if (alive(dir)) { releaseSlot(dir); return; }
    d.removeDir(dir);
  } catch { /* best effort */ }
}

/**
 * Pick the namespace for this launch. EVERY launch slots — bare or profiled
 * (a profile's old per-profile namespace let two launches of the same profile
 * kill-session each other, the reported bug on a second path).
 *
 * Returns null only when CCR_SESSION or CCR_STATE_DIR is set — the user named
 * this instance explicitly, and an explicit choice always outranks an
 * automatic one. Returns { exhausted: true } when every slot is held by a
 * live instance: the launch must REFUSE (features/instance-lifecycle.feature:
 * "A thirty-third instance is refused") — the old fallback target, the shared
 * container, is exactly the collision this module exists to prevent.
 *
 * @param {{ profile?: string } & Partial<Deps>} [opts]
 * @returns {{ slot: number, session: string, stateDir: string, attached: boolean } | { exhausted: true } | null}
 */
function allocateSlot(opts = {}) {
  const d = withDefaults(opts);
  if (d.env.CCR_SESSION || d.env.CCR_STATE_DIR) return null;

  // Ephemerality's collector: each launch clears dirs whose process is gone.
  try { sweepDeadInstances(opts); } catch { /* housekeeping must not block a launch */ }

  for (let n = 1; n <= MAX_SLOTS; n++) {
    const p = slotPaths(n, d.home);
    if (!d.dirUsable(p.stateDir)) continue;
    const { live, attached } = d.inspect(p.stateDir);
    if (live) continue;
    // The owner file lands inside the slot dir, so it has to exist first.
    // Creating a dir we then fail to reserve is harmless and bounded by MAX_SLOTS.
    try { d.ensureDir(p.stateDir); } catch { continue; } // unusable slot → next
    if (d.reserve(p.stateDir)) return { ...p, attached };
  }
  return { exhausted: true };
}

/**
 * The two env vars that hand a resolved slot to every launcher — and, through
 * scripts/launch.sh, to tmux's session and socket names.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ session?: string, stateDir?: string, exhausted?: boolean } | null} slot
 * @returns {NodeJS.ProcessEnv} `env` itself when there is no slot to apply
 */
function applySlotEnv(env, slot) {
  if (!slot || slot.exhausted || !slot.session || !slot.stateDir) return env;
  return { ...env, CCR_SESSION: slot.session, CCR_STATE_DIR: slot.stateDir };
}

/**
 * @typedef {object} Deps
 * @property {NodeJS.ProcessEnv} env
 * @property {string} home
 * @property {(dir: string) => {live: boolean, attached: boolean}} inspect
 * @property {(dir: string) => boolean} reserve
 * @property {(dir: string) => boolean} dirUsable
 * @property {(dir: string) => void} ensureDir
 * @property {(dir: string) => void} removeDir
 * @property {(dir: string) => string[]} listDir
 */

module.exports = {
  MAX_SLOTS,
  OWNER_FILE,
  slotPaths,
  allocateSlot,
  applySlotEnv,
  releaseSlot,
  sweepDeadInstances,
  retireInstance,
  defaultInspect,
  defaultReserve,
  defaultDirUsable,
  ownerPid,
  pidAlive,
};
