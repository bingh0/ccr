// @ts-check
'use strict';

// src/launch-win.js — native-Windows launcher for `ccr` / `ccr <profile>`.
//
// Replaces the bash+tmux launch layer (scripts/launch.sh) on win32 by driving
// Windows Terminal (wt.exe) split panes: pane 0 runs Claude Code, pane 1 runs
// `ccr sidecar`, with CCR_STATE_DIR injected into both. See SPEC §4.2/§5.2.
//
// The pure, side-effect-free helpers (profile validation, state resolution,
// wt.exe argv construction, the injected wt.exe lookup) are unit-tested without
// spawning anything; run()/fallbackNoWt() drive the real side effects through
// the injectable Deps in withDefaults().

const path = require('node:path');
const os = require('node:os');

// Profile names land in filesystem paths and a spawned command, so allow only a
// safe identifier — identical to the allow-list in scripts/launch.sh.
const PROFILE_RE = /^[A-Za-z0-9._-]+$/;

// Characters we cannot safely embed in the per-pane `cmd /k` payload, even with
// every path wrapped in double quotes:
//   "       ends the quoted string;
//   %       triggers cmd.exe variable expansion (it fires even inside quotes);
//   \r \n   break the command line.
// By contrast & | < > ^ ( ) ARE literal inside the double quotes we wrap every
// value in, so they need no special handling. The trust boundary here is the
// user's own env/paths (self-injection, not RCE), so the goal is to turn a
// silently-broken — or, with %, a maliciously-expandable — command into a clear,
// actionable error rather than to defend against an attacker.
const WT_UNSAFE_RE = /["%\r\n]/;

/**
 * @param {string} value
 * @returns {boolean} true if `value` can be safely interpolated into the cmd /k payload
 */
function isWtArgSafe(value) {
  return !WT_UNSAFE_RE.test(String(value));
}

// Upstream default split: the sidecar gets ~34% of the width.
const DEFAULT_SIDEBAR_PCT = 34;

// Where the sidecar pane sits relative to Claude. 'right' is a vertical split
// (wt split-pane -V, the default — matches the width-based sizing above);
// 'bottom' is a horizontal split (-H). Set via CCR_SIDEBAR_SIDE.
const DEFAULT_SIDEBAR_SIDE = 'right';

/**
 * Map a sidebar side ('right' | 'bottom') to the wt.exe split-pane flag.
 * 'right' → '-V' (new pane to the right), 'bottom' → '-H' (new pane below).
 * Anything unrecognized falls back to the default side.
 *
 * @param {string} [side]
 * @returns {'-V'|'-H'}
 */
function sidebarSplitFlag(side) {
  const s = String(side || DEFAULT_SIDEBAR_SIDE).toLowerCase();
  return s === 'bottom' ? '-H' : '-V';
}

/**
 * @param {unknown} profile
 * @returns {boolean} true if the profile name is a safe identifier
 */
function validateProfile(profile) {
  return typeof profile === 'string' && PROFILE_RE.test(profile);
}

/**
 * Resolve the Claude command, tmux-equivalent session name, state dir, and (for
 * profiles) the expected CCS instance dir. Mirrors scripts/launch.sh, honoring
 * the CC_BIN / CCR_SESSION / CCR_STATE_DIR overrides.
 *
 * @param {string} [profile] CCS profile name, or undefined for plain `claude`
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [opts]
 * @returns {{ ccCmd: string, session: string, stateDir: string,
 *   instanceDir: string|null, usesCcs: boolean }}
 */
function resolveProfileState(profile, opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();

  if (profile) {
    return {
      ccCmd: `ccs ${profile}`,
      session: env.CCR_SESSION || `ccr-${profile}`,
      stateDir: env.CCR_STATE_DIR || path.join(home, '.ccr', profile),
      instanceDir: path.join(home, '.ccs', 'instances', profile),
      usesCcs: true,
    };
  }
  return {
    ccCmd: env.CC_BIN || 'claude',
    session: env.CCR_SESSION || 'ccr',
    stateDir: env.CCR_STATE_DIR || path.join(home, '.ccr'),
    instanceDir: null,
    usesCcs: false,
  };
}

/**
 * Convert a width percentage (e.g. 34) into the fraction string wt.exe's
 * `split-pane -s` expects (e.g. "0.34"). Clamps to a sane 5..95 range.
 *
 * @param {number} [pct]
 * @returns {string}
 */
function sidebarFraction(pct) {
  let p = Number(pct);
  if (!Number.isFinite(p)) p = DEFAULT_SIDEBAR_PCT;
  p = Math.min(95, Math.max(5, Math.round(p)));
  // Strip any float noise: 34 -> "0.34", 50 -> "0.5".
  return String(Math.round(p) / 100);
}

/**
 * Build the per-pane cmd.exe payload. Env is injected with `set "VAR=val"` so a
 * path with spaces (or & | < >, which are literal inside the quotes) is fine and
 * no trailing space is captured. Callers MUST pre-validate `stateDir` with
 * isWtArgSafe — `"` and `%` are NOT made safe by these quotes (see WT_UNSAFE_RE).
 *
 * @param {string} stateDir
 * @param {string} body the command(s) to run after the env is set
 * @returns {string}
 */
function paneCommand(stateDir, body) {
  return `set "CCR_STATE_DIR=${stateDir}"&& ${body}`;
}

/**
 * Build the argv passed to wt.exe (excluding the wt.exe path itself):
 *   new-tab --title Claude cmd /k "<pane0>" ; split-pane -H -s <frac> cmd /k "<pane1>"
 *
 * The ";" pane separator is its own argv token (wt re-parses it). Per-pane env
 * is injected via `cmd /k set ...` rather than wt global env. After Claude
 * exits, pane 0 (unconditional `&`) drops the `exited` sentinel (so the sidecar
 * can show a clean "session ended" state) and deletes the temp settings file
 * (cleanup-after-window-closes; the file was only needed at Claude startup).
 *
 * Throws if any interpolated value contains a character that would break (or, in
 * the case of %, hijack) the cmd /k payload — see isWtArgSafe. run() catches
 * this and reports a clean error instead of spawning a broken command.
 *
 * @param {{ ccCmd: string, settingsFile: string, stateDir: string,
 *   node: string, ccrJs: string, sidebarPct?: number, sidebarSide?: string }} o
 * @returns {string[]}
 */
function buildWtArgs(o) {
  const { ccCmd, settingsFile, stateDir, node, ccrJs } = o;
  for (const [label, value] of [
    ['profile/state dir', stateDir],
    ['settings file path', settingsFile],
    ['claude command', ccCmd],
    ['node path', node],
    ['ccr.js path', ccrJs],
  ]) {
    if (!isWtArgSafe(value)) {
      throw new Error(
        `cannot launch: ${label} contains an unsupported character (" or %) for the ` +
        `Windows Terminal launcher: ${value}`,
      );
    }
  }
  const frac = sidebarFraction(o.sidebarPct);
  const splitFlag = sidebarSplitFlag(o.sidebarSide);
  const exited = path.win32.join(stateDir, 'exited');

  const pane0 = paneCommand(
    stateDir,
    `${ccCmd} --settings "${settingsFile}" & type nul > "${exited}" & del /q "${settingsFile}"`,
  );
  const pane1 = paneCommand(stateDir, `"${node}" "${ccrJs}" sidecar`);

  return [
    'new-tab', '--title', 'Claude', 'cmd', '/k', pane0,
    ';',
    'split-pane', splitFlag, '-s', frac, 'cmd', '/k', pane1,
  ];
}

/**
 * Resolve wt.exe via `where`, or return null if absent. The lookup is injected
 * so this stays unit-testable; the default shells out to `where`.
 *
 * @param {{ runWhere?: (name: string) => (string|null) }} [opts]
 * @returns {string|null}
 */
function findWindowsTerminal(opts = {}) {
  const lookup = opts.runWhere || defaultWhere;
  return lookup('wt') || lookup('wt.exe') || null;
}

/**
 * @param {string} name
 * @returns {string|null} first match path, or null
 */
function defaultWhere(name) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('where', [name], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first || null;
}

const inject = require('./settings-inject');
const { ensureSecureDir } = require('./state-dir');

/**
 * Fill in real-environment implementations for anything the caller didn't
 * inject. Every external effect (PATH lookups, fs, spawn, output) flows through
 * here so run() can be unit-tested with pure stand-ins.
 *
 * @param {Partial<Deps>} deps
 * @returns {Deps}
 */
function withDefaults(deps) {
  const env = deps.env || process.env;
  const home = deps.home || os.homedir();
  return {
    env,
    home,
    node: deps.node || process.execPath,
    ccrJs: deps.ccrJs || path.join(__dirname, '..', 'bin', 'ccr.js'),
    out: deps.out || ((s) => { process.stdout.write(s); }),
    err: deps.err || ((s) => { process.stderr.write(s); }),
    findWt: deps.findWt || (() => findWindowsTerminal()),
    which: deps.which || defaultWhere,
    existsDir: deps.existsDir || defaultExistsDir,
    listDir: deps.listDir || defaultListDir,
    ensureDir: deps.ensureDir || ensureSecureDir,
    removeExited: deps.removeExited || defaultRemoveExited,
    writeSettings: deps.writeSettings || ((s) => inject.writeSettingsFile(s)),
    cleanup: deps.cleanup || ((f) => inject.cleanupSettingsFile(f)),
    spawnWt: deps.spawnWt || defaultSpawnWt,
  };
}

/** @param {string} dir @returns {boolean} */
function defaultExistsDir(dir) {
  try {
    return require('node:fs').statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} dir @returns {string[]} */
function defaultListDir(dir) {
  try {
    return require('node:fs').readdirSync(dir);
  } catch {
    return [];
  }
}

/** @param {string} stateDir @returns {void} */
function defaultRemoveExited(stateDir) {
  try {
    require('node:fs').rmSync(path.join(stateDir, 'exited'), { force: true });
  } catch {
    // best effort
  }
}

/** @param {string} wt @param {string[]} args @returns {{status:number|null, error?:Error}} */
function defaultSpawnWt(wt, args) {
  return require('node:child_process').spawnSync(wt, args, { stdio: 'ignore' });
}

/**
 * The graceful no-Windows-Terminal fallback: keep the working native CLI usable
 * instead of dead-ending. Returns 1 (no crash, no stack trace). SPEC §6 / §8.7.
 *
 * @param {{ err: (s: string) => void }} d
 * @returns {number}
 */
function fallbackNoWt(d) {
  d.err(
    'ccr: Windows Terminal (wt.exe) not found — it hosts the live sidecar.\n' +
    '     Install it:  winget install Microsoft.WindowsTerminal\n' +
    '     Until then these native commands work without it:\n' +
    '       ccr economy      one-off economy panel\n' +
    "       ccr statusline   wire into Claude Code's statusLine\n" +
    '       ccr doctor       check your setup\n');
  return 1;
}

/**
 * `ccr [profile]` on native Windows: split a Windows Terminal window into
 * Claude Code + ccr sidecar. Implements SPEC §4.2 steps 1–7. Returns an exit
 * code. All side effects are injectable for testing (see withDefaults).
 *
 * @param {string} [profile]
 * @param {Partial<Deps>} [deps]
 * @returns {number}
 */
function run(profile, deps = {}) {
  const d = withDefaults(deps);

  // 1. Validate the profile (it lands in paths and a spawned command).
  if (profile !== undefined && !validateProfile(profile)) {
    d.err(`ccr: invalid profile name '${profile}' (allowed: letters, digits, . _ -)\n`);
    return 1;
  }

  // 2. Require Windows Terminal, else fall back gracefully.
  const wt = d.findWt();
  if (!wt) return fallbackNoWt(d);

  // 3. Resolve profile state + required binaries.
  const st = resolveProfileState(profile, { env: d.env, home: d.home });
  if (st.usesCcs) {
    if (!d.which('ccs')) {
      d.err("ccr: 'ccs' not found on PATH — pass a profile only if CCS is installed.\n");
      return 1;
    }
    if (st.instanceDir && !d.existsDir(st.instanceDir)) {
      d.err(`ccr: CCS profile '${profile}' not found (${st.instanceDir}).\n`);
      const avail = d.listDir(path.join(d.home, '.ccs', 'instances')).join(' ');
      d.err(`     available: ${avail}\n`);
      return 1;
    }
  } else {
    const bin = st.ccCmd.split(' ')[0];
    if (!d.which(bin)) {
      d.err(`ccr: '${bin}' not found on PATH.\n`);
      return 1;
    }
  }

  // 4. Prepare the per-profile state dir; clear a stale sentinel.
  try { d.ensureDir(st.stateDir); } catch { /* best effort */ }
  d.removeExited(st.stateDir);

  // 5. Inject statusLine via a temp settings FILE (avoids CLI JSON quoting).
  const command = inject.buildStatusLineCommandInline({ node: d.node, ccrJs: d.ccrJs });
  const settingsFile = d.writeSettings(inject.buildSettings(command));

  // 6. Build + spawn the wt.exe command (CCR_STATE_DIR injected per-pane).
  const pct = parseInt(String(d.env.CCR_SIDEBAR_PCT), 10);
  let args;
  try {
    args = buildWtArgs({
      ccCmd: st.ccCmd,
      settingsFile,
      stateDir: st.stateDir,
      node: d.node,
      ccrJs: d.ccrJs,
      sidebarPct: Number.isFinite(pct) ? pct : DEFAULT_SIDEBAR_PCT,
      sidebarSide: d.env.CCR_SIDEBAR_SIDE || DEFAULT_SIDEBAR_SIDE,
    });
  } catch (e) {
    d.err(`ccr: ${e instanceof Error ? e.message : String(e)}\n`);
    d.cleanup(settingsFile); // window never opened → nothing else will clean up
    return 1;
  }
  const r = d.spawnWt(wt, args);
  if (r.error) {
    d.err(`ccr: failed to launch Windows Terminal: ${r.error.message}\n`);
    d.cleanup(settingsFile); // window never opened → pane 0 can't clean up
    return 1;
  }
  // 7. On success the settings file is cleaned up by pane 0 when Claude exits.
  return typeof r.status === 'number' ? r.status : 0;
}

/**
 * @typedef {object} Deps
 * @property {NodeJS.ProcessEnv} env
 * @property {string} home
 * @property {string} node
 * @property {string} ccrJs
 * @property {(s: string) => void} out
 * @property {(s: string) => void} err
 * @property {() => (string|null)} findWt
 * @property {(name: string) => (string|null)} which
 * @property {(dir: string) => boolean} existsDir
 * @property {(dir: string) => string[]} listDir
 * @property {(dir: string) => void} ensureDir
 * @property {(dir: string) => void} removeExited
 * @property {(settings: object) => string} writeSettings
 * @property {(file: string) => void} cleanup
 * @property {(wt: string, args: string[]) => {status: number|null, error?: Error}} spawnWt
 */

module.exports = {
  PROFILE_RE,
  DEFAULT_SIDEBAR_PCT,
  DEFAULT_SIDEBAR_SIDE,
  validateProfile,
  isWtArgSafe,
  resolveProfileState,
  sidebarFraction,
  sidebarSplitFlag,
  buildWtArgs,
  findWindowsTerminal,
  run,
  fallbackNoWt,
};
