// @ts-check
'use strict';
// src/launch-vscode.js — split-terminal launcher for VS Code's integrated
// terminal (any OS). Unlike the wt.exe path (a separate window) or tmux (a real
// multiplexer), a shell process CANNOT split the VS Code terminal itself — the
// `code` CLI exposes no "run command" verb. So we automate everything AROUND the
// split: do all the state/statusLine wiring, run Claude in the CURRENT pane, and
// hand the user a prominent, clipboard-copied one-liner for the new pane.
//
//   run(profile)  → banner + clipboard + Claude in this pane; sidecar one-liner
//                   for the split pane (Ctrl+Shift+5 / Cmd+\).
//   hint(dir)     → reprint that banner + re-copy the one-liner (no Claude).
//
// The zero-dependency / no-config-mutation contracts are preserved exactly as in
// launch-win: statusLine is injected via a per-launch temp settings file.

const path = require('node:path');
const os = require('node:os');
const launchWin = require('./launch-win');
const inject = require('./settings-inject');
const { ensureSecureDir } = require('./state-dir');

/**
 * VS Code's "Split Terminal" default keybinding, per platform.
 * @param {string} [platform]
 * @returns {string}
 */
function splitKeybinding(platform) {
  return (platform || process.platform) === 'darwin' ? 'Cmd+\\' : 'Ctrl+Shift+5';
}

/**
 * The command the user runs in the split pane. Carries the resolved state dir as
 * an explicit arg (shell-agnostic: no per-shell `set`/`$env:`/`export` needed).
 * Prefers the `ccr` binary when on PATH; falls back to node + ccr.js by path.
 * @param {{ stateDir: string, ccrBin?: string|null, node: string, ccrJs: string, hint?: boolean }} o
 * @returns {string}
 */
function sidecarPasteCommand(o) {
  const head = o.ccrBin ? 'ccr' : `"${o.node}" "${o.ccrJs}"`;
  const tail = o.hint ? ' --hint' : ` --state-dir "${o.stateDir}"`;
  return `${head} sidecar${tail}`;
}

/**
 * OSC 52 clipboard-set escape — zero-dep, works over SSH/remote/dev-containers,
 * and honored by VS Code's terminal. Setting the clipboard needs no native tool.
 * @param {string} text
 * @returns {string}
 */
function osc52(text) {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

/**
 * The prominent, scrollback-findable banner. A bright reverse-video header plus a
 * blinking ▶/◀ marker is the "animated cue" — terminals honoring blink animate
 * it (live AND when scrolled to); elsewhere it degrades to a bold static banner.
 * @param {{ sidecarCmd: string, splitKey: string, hintCmd: string, color: boolean }} o
 * @returns {string}
 */
function buildBanner(o) {
  const c = o.color ? (/** @type {string} */ code, /** @type {string} */ s) => `\x1b[${code}m${s}\x1b[0m` : (/** @type {string} */ _code, /** @type {string} */ s) => s;
  const blink = o.color ? (/** @type {string} */ s) => `\x1b[5m${s}\x1b[25m` : (/** @type {string} */ s) => s;
  return [
    '',
    c('1;30;103', `  ${blink('▶')}  ccr · live sidecar — split your VS Code terminal  ${blink('◀')}  `),
    '',
    `  ${c('1;96', '1.')} Split this terminal:  ${c('1;97', o.splitKey)}`,
    `  ${c('1;96', '2.')} In the new pane, run ${c('2', '(already on your clipboard — just paste)')}:`,
    '',
    `       ${c('1;92', o.sidecarCmd)}`,
    '',
    c('2', `  Claude is starting in THIS pane. Lost these steps? Run:  ${o.hintCmd}`),
    '',
  ].join('\n') + '\n';
}

/**
 * Best-effort copy: OSC 52 first (covers VS Code + remote), then a native tool
 * for terminals with OSC 52 disabled. Never throws; silent if nothing is found.
 * @param {string} text
 * @param {{ platform: string, out: (s: string) => void, spawnCopy: (cmd: string, args: string[], input: string) => { status: number|null, error?: Error } }} d
 */
function copyToClipboard(text, d) {
  try { d.out(osc52(text)); } catch { /* terminal may not support OSC 52 */ }
  const p = d.platform;
  const attempts = p === 'win32' ? [['clip', []]]
    : p === 'darwin' ? [['pbcopy', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]];
  for (const [cmd, args] of attempts) {
    try {
      const r = d.spawnCopy(String(cmd), /** @type {string[]} */ (args), text);
      if (r && !r.error && (r.status === 0 || r.status == null)) return;
    } catch { /* try the next tool */ }
  }
}

/**
 * `ccr [profile]` inside a VS Code integrated terminal: wire the split-view
 * sidecar, then run Claude in the current pane. Returns Claude's exit code.
 * @param {string} [profile]
 * @param {Partial<Deps>} [deps]
 * @returns {number}
 */
function run(profile, deps = {}) {
  const d = withDefaults(deps);

  if (profile !== undefined && !launchWin.validateProfile(profile)) {
    d.err(`ccr: invalid profile name '${profile}' (allowed: letters, digits, . _ -)\n`);
    return 1;
  }

  const st = launchWin.resolveProfileState(profile, { env: d.env, home: d.home });
  if (st.usesCcs) {
    if (!d.which('ccs')) {
      d.err("ccr: 'ccs' not found on PATH — pass a profile only if CCS is installed.\n");
      return 1;
    }
    if (st.instanceDir && !d.existsDir(st.instanceDir)) {
      d.err(`ccr: CCS profile '${profile}' not found (${st.instanceDir}).\n`);
      d.err(`     available: ${d.listDir(path.join(d.home, '.ccs', 'instances')).join(' ')}\n`);
      return 1;
    }
  } else {
    const bin = st.ccCmd.split(' ')[0];
    if (!d.which(bin)) { d.err(`ccr: '${bin}' not found on PATH.\n`); return 1; }
  }

  try { d.ensureDir(st.stateDir); } catch { /* best effort */ }
  d.removeExited(st.stateDir);

  // statusLine via a per-launch temp settings file (no ~/.claude mutation).
  const command = inject.buildStatusLineCommandInline({ node: d.node, ccrJs: d.ccrJs });
  const settingsFile = d.writeSettings(inject.buildSettings(command));

  // Show the split instructions + copy the sidecar one-liner BEFORE Claude takes
  // over the pane (the clipboard + hint make it recoverable once it scrolls off).
  const ccrBin = d.which('ccr');
  const sidecarCmd = sidecarPasteCommand({ stateDir: st.stateDir, ccrBin, node: d.node, ccrJs: d.ccrJs });
  const hintCmd = sidecarPasteCommand({ stateDir: st.stateDir, ccrBin, node: d.node, ccrJs: d.ccrJs, hint: true });
  d.out(buildBanner({ sidecarCmd, splitKey: splitKeybinding(d.platform), hintCmd, color: d.color }));
  copyToClipboard(sidecarCmd, d);

  // Run Claude in the current pane (blocks until exit). The temp settings file is
  // always removed; the "session ended" sentinel is only dropped if Claude
  // actually ran — a failed spawn must NOT flip the sidecar to "ended".
  const parts = st.ccCmd.split(' ');
  const r = d.spawnClaude(parts[0], [...parts.slice(1), '--settings', settingsFile]);
  d.cleanup(settingsFile);
  if (r && r.error) { d.err(`ccr: failed to launch Claude: ${r.error.message}\n`); return 1; }
  d.dropExited(st.stateDir);
  return r && typeof r.status === 'number' ? r.status : 0;
}

/**
 * Reprint the split instructions and re-copy the sidecar one-liner for an
 * already-resolved state dir. Backs `ccr sidecar --hint`. Never launches Claude.
 * @param {string} stateDir
 * @param {Partial<Deps>} [deps]
 * @returns {number}
 */
function hint(stateDir, deps = {}) {
  const d = withDefaults(deps);
  const ccrBin = d.which('ccr');
  const sidecarCmd = sidecarPasteCommand({ stateDir, ccrBin, node: d.node, ccrJs: d.ccrJs });
  const hintCmd = sidecarPasteCommand({ stateDir, ccrBin, node: d.node, ccrJs: d.ccrJs, hint: true });
  d.out(buildBanner({ sidecarCmd, splitKey: splitKeybinding(d.platform), hintCmd, color: d.color }));
  copyToClipboard(sidecarCmd, d);
  return 0;
}

/**
 * Build the spawn invocation for launching Claude in the CURRENT pane.
 *
 * On POSIX this is a direct exec of `bin`. On Windows the resolved binary is
 * typically `claude.cmd` / `ccs.cmd`, which Node's spawnSync refuses to run by
 * bare name without a shell (it would ENOENT) — so we resolve the real path via
 * `which` and run it through cmd.exe with our own quoting, which keeps a temp
 * path containing spaces working. We reject the two characters cmd quoting
 * cannot neutralize — `"` (ends the quote) and `%` (cmd expansion), plus CR/LF —
 * with a clear error rather than spawn a broken or hijackable line. This mirrors
 * the WT_UNSAFE policy in launch-win.js; trust boundary is the user's own env.
 *
 * Returns either a spawn descriptor or, on a rejected character, an `{ error }`
 * that run() surfaces exactly like a spawn failure.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{ platform: string, which: (name: string) => (string|null) }} o
 * @returns {{ command: string, args: string[]|null, shell: boolean } | { error: Error }}
 */
function buildClaudeSpawn(bin, args, o) {
  if (o.platform !== 'win32') {
    return { command: bin, args, shell: false };
  }
  const resolved = o.which(bin) || bin;
  const all = [resolved, ...args.map(String)];
  const bad = all.find((p) => /["%\r\n]/.test(p));
  if (bad !== undefined) {
    return { error: new Error(
      `argument contains an unsupported character (", %, or newline) for the Windows shell: ${JSON.stringify(bad)}`,
    ) };
  }
  // cmd.exe strips the outer quote pair Node adds around the /c payload, leaving
  // each value individually quoted — spaces are safe, `"`/`%` are pre-rejected.
  return { command: all.map((p) => `"${p}"`).join(' '), args: null, shell: true };
}

/**
 * Real-environment Claude launcher: resolve+route through cmd.exe on Windows
 * (see buildClaudeSpawn), direct exec elsewhere. Stays injectable so tests drive
 * run() without spawning — but the Windows resolution itself is unit-tested via
 * buildClaudeSpawn so this seam can't silently regress to a bare-name spawn.
 *
 * @param {string} bin
 * @param {string[]} args
 * @returns {{ status: number|null, error?: Error }}
 */
function defaultSpawnClaude(bin, args) {
  const built = buildClaudeSpawn(bin, args, { platform: process.platform, which: defaultWhich });
  if ('error' in built) return { status: null, error: built.error };
  const { spawnSync } = require('node:child_process');
  return built.shell
    ? spawnSync(built.command, { stdio: 'inherit', shell: true })
    : spawnSync(built.command, built.args || [], { stdio: 'inherit' });
}

/** @param {string} name @returns {string|null} */
function defaultWhich(name) {
  const { spawnSync } = require('node:child_process');
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [name], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
}

/**
 * @param {Partial<Deps>} deps
 * @returns {Deps}
 */
function withDefaults(deps) {
  const env = deps.env || process.env;
  return {
    env,
    home: deps.home || os.homedir(),
    node: deps.node || process.execPath,
    ccrJs: deps.ccrJs || path.join(__dirname, '..', 'bin', 'ccr.js'),
    platform: deps.platform || process.platform,
    color: deps.color != null ? deps.color : (!!process.stdout.isTTY && !env.NO_COLOR),
    out: deps.out || ((s) => { process.stdout.write(s); }),
    err: deps.err || ((s) => { process.stderr.write(s); }),
    which: deps.which || defaultWhich,
    existsDir: deps.existsDir || ((dir) => { try { return require('node:fs').statSync(dir).isDirectory(); } catch { return false; } }),
    listDir: deps.listDir || ((dir) => { try { return require('node:fs').readdirSync(dir); } catch { return []; } }),
    ensureDir: deps.ensureDir || ensureSecureDir,
    removeExited: deps.removeExited || ((dir) => { try { require('node:fs').rmSync(path.join(dir, 'exited'), { force: true }); } catch { /* best effort */ } }),
    dropExited: deps.dropExited || ((dir) => { try { require('node:fs').writeFileSync(path.join(dir, 'exited'), ''); } catch { /* best effort */ } }),
    writeSettings: deps.writeSettings || ((s) => inject.writeSettingsFile(s)),
    cleanup: deps.cleanup || ((f) => inject.cleanupSettingsFile(f)),
    spawnClaude: deps.spawnClaude || defaultSpawnClaude,
    spawnCopy: deps.spawnCopy || ((cmd, args, input) => require('node:child_process').spawnSync(cmd, args, { input, stdio: ['pipe', 'ignore', 'ignore'] })),
  };
}

/**
 * @typedef {object} Deps
 * @property {NodeJS.ProcessEnv} env
 * @property {string} home
 * @property {string} node
 * @property {string} ccrJs
 * @property {string} platform
 * @property {boolean} color
 * @property {(s: string) => void} out
 * @property {(s: string) => void} err
 * @property {(name: string) => (string|null)} which
 * @property {(dir: string) => boolean} existsDir
 * @property {(dir: string) => string[]} listDir
 * @property {(dir: string) => void} ensureDir
 * @property {(dir: string) => void} removeExited
 * @property {(dir: string) => void} dropExited
 * @property {(settings: object) => string} writeSettings
 * @property {(file: string) => void} cleanup
 * @property {(bin: string, args: string[]) => {status: number|null, error?: Error}} spawnClaude
 * @property {(cmd: string, args: string[], input: string) => {status: number|null, error?: Error}} spawnCopy
 */

module.exports = { splitKeybinding, sidecarPasteCommand, osc52, buildBanner, copyToClipboard, buildClaudeSpawn, run, hint };
