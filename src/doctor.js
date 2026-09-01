// @ts-check
'use strict';
// src/doctor.js — `ccr doctor`: check the local setup and capture status.
// Pure Node; the few external checks use `command -v`. Diagnoses the common
// "nothing happens" causes (ccr not linked, tmux/ccs missing, no capture yet).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { stripControl } = require('./sanitize');
const { loadPaneConfig } = require('./pane-config');

const ok = (/** @type {string} */ s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (/** @type {string} */ s) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (/** @type {string} */ s) => `\x1b[33m⚠\x1b[0m ${s}`;
const dim = (/** @type {string} */ s) => `\x1b[2m${s}\x1b[0m`;
const bold = (/** @type {string} */ s) => `\x1b[1m${s}\x1b[0m`;

/** @param {string} cmd → resolved path or null */
function has(cmd) {
  // Only ever called with literal tool names; refuse anything that isn't a bare
  // command word so this can never become a shell-injection sink.
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(cmd)) return null;
  try {
    // Native Windows has no `sh`; `where` is the built-in PATH lookup there.
    const r = process.platform === 'win32'
      ? spawnSync('where', [cmd], { encoding: 'utf8' })
      : spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return r.stdout.trim().split(/\r?\n/)[0] || null; // `where` may list several
  } catch { return null; }
}
function isExec(/** @type {string} */ f) {
  try { return (fs.statSync(f).mode & 0o111) !== 0; } catch { return false; }
}

// ccr's tmux dialect has a floor. 3.1 is HARD: percentage splits
// (`split-window -l 34%`, since `-p` was deprecated there and 3.4+ rejects it)
// and `terminal-features`, which sidecar/ccr.tmux.conf needs for true colour
// over mosh. 3.2 adds pane-scoped hooks, which the launcher uses to keep the
// sidebar out of copy-mode; below that it degrades quietly rather than
// breaking, so 3.2 is what we ask for and 3.1 is what we tolerate.
const TMUX_MIN = { major: 3, minor: 2 };
/** @param {string} bin @returns {{major:number,minor:number}|null} */
function tmuxVersion(bin) {
  try {
    const r = spawnSync(bin, ['-V'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    // "tmux 3.7c", "tmux 3.2a", "tmux next-3.6" — only the numbers matter.
    const m = /(\d+)\.(\d+)/.exec(r.stdout || '');
    return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
  } catch { return null; }
}

/**
 * @param {{ platform?: string, has?: (cmd: string) => (string|null),
 *   tmuxVersion?: (bin: string) => ({major:number,minor:number}|null),
 *   homedir?: string, repo?: string, write?: (s: string) => void,
 *   env?: Record<string, string|undefined> }} [opts]
 *   side effects are injectable for testing; defaults hit the real environment
 * @returns {number} exit code (0 = healthy)
 */
function run(opts = {}) {
  const platform = opts.platform || process.platform;
  const hasFn = opts.has || has;
  const tmuxVerFn = opts.tmuxVersion || tmuxVersion;
  const homedir = opts.homedir || os.homedir();
  const REPO = opts.repo || path.join(__dirname, '..');
  const write = opts.write || ((s) => { process.stdout.write(s); });
  const isWin = platform === 'win32';
  const out = [bold('ccr doctor'), ''];
  let problems = 0;

  const [maj, min] = process.versions.node.split('.').map(Number);
  const nodeOk = maj > 22 || (maj === 22 && min >= 17);
  out.push(nodeOk ? ok(`node ${process.version}`) : bad(`node ${process.version} — need >= 22.17`));
  if (!nodeOk) problems++;

  const ccr = hasFn('ccr');
  out.push(ccr ? ok(`ccr on PATH (${stripControl(ccr)})`) : warn('ccr not on PATH — run `npm link` in the repo'));
  if (!ccr) problems++;

  if (isWin) {
    // Native Windows hosts the sidecar in Windows Terminal — no tmux/bash/WSL.
    const wt = hasFn('wt');
    if (wt) {
      out.push(ok(`Windows Terminal (sidecar host) (${stripControl(wt)})`));
    } else {
      out.push(warn('Windows Terminal not found — the sidecar needs it (winget install Microsoft.WindowsTerminal); the CLI still works'));
      problems++;
    }
    // statusLine is injected inline (node + bin/ccr.js by path) via the per-launch
    // temp settings file, so there's no shipped shim asset to check on Windows.
  } else {
    const tmux = hasFn('tmux');
    if (!tmux) {
      out.push(warn('tmux missing — needed for the `ccr [profile]` sidebar'));
      problems++;
    } else {
      const v = tmuxVerFn(tmux);
      // An unreadable version is not evidence of a problem — say so and move on
      // rather than manufacturing a failure out of a parse miss.
      if (!v) {
        out.push(ok(`tmux (${stripControl(tmux)})`) + dim(' — version unreadable'));
      } else if (v.major < TMUX_MIN.major
          || (v.major === TMUX_MIN.major && v.minor < TMUX_MIN.minor)) {
        out.push(warn(`tmux ${v.major}.${v.minor} (${stripControl(tmux)}) — ccr wants `
          + `${TMUX_MIN.major}.${TMUX_MIN.minor}+; below 3.1 the sidebar split fails outright`));
        problems++;
      } else {
        out.push(ok(`tmux ${v.major}.${v.minor} (${stripControl(tmux)})`));
      }
    }
    out.push(hasFn('bash') ? ok('bash') : warn('bash missing — needed for the launcher'));

    const sl = path.join(REPO, 'sidecar', 'ccr-statusline');
    out.push(isExec(sl) ? ok('sidecar/ccr-statusline is executable') : warn('sidecar/ccr-statusline not executable (the launcher self-heals this)'));
  }

  const ccs = hasFn('ccs');
  if (ccs) {
    /** @type {string[]} */
    let profiles = [];
    try { profiles = fs.readdirSync(path.join(homedir, '.ccs', 'instances')).filter((p) => !p.startsWith('.')); } catch { /* none */ }
    // Profile + path come from the filesystem; sanitize before display.
    out.push(ok(`ccs (${stripControl(ccs)}) · profiles: ${profiles.map(stripControl).join(', ') || '(none)'}`));
  } else {
    out.push(dim('· ccs not installed (optional — only for `ccr <profile>`)'));
  }

  // Pane wiring. This command exists to diagnose "nothing happens", and a pane
  // config the user wrote and got wrong is exactly that — the sidecar has room
  // for a one-line marker and no more. Here there is room for the path, the
  // reason, and what ccr actually read out of the file, which is the question
  // someone whose pane never appeared is really asking.
  const cfg = loadPaneConfig({ env: opts.env, home: homedir });
  if (cfg.error) {
    out.push(bad(`pane config: ${cfg.error} — ${stripControl(cfg.configPath)}`));
    problems++;
  } else if (cfg.panes.length) {
    out.push(ok(`pane config: ${cfg.panes.length} pane(s) (${stripControl(cfg.configPath)})`));
    // The path as ccr resolved it, not as written: a tilde that did not expand
    // is invisible in the source string and obvious in the resolved one.
    for (const pane of cfg.panes) out.push(dim(`  · ${stripControl(pane.path)}`));
  } else {
    out.push(dim(`· no panes configured (optional — ${stripControl(cfg.configPath)})`));
  }

  // newest captured snapshot across the container. Instances live TWO levels
  // down under the 0.4.0 layout (~/.ccr/instances/<n>/last-status.json) — the
  // one-level scan alone would report "no status captured" while instances run
  // fine (features/instance-lifecycle.feature: "doctor finds a live instance's
  // captured status"). The root and one-level entries are still scanned so a
  // pre-migration home keeps diagnosing.
  const ccrDir = path.join(homedir, '.ccr');
  const dirs = [ccrDir];
  try {
    for (const d of fs.readdirSync(ccrDir)) {
      const sub = path.join(ccrDir, d);
      try { if (fs.statSync(sub).isDirectory()) dirs.push(sub); } catch { /* ignore */ }
    }
  } catch { /* none */ }
  try {
    const inst = path.join(ccrDir, 'instances');
    for (const d of fs.readdirSync(inst)) {
      const sub = path.join(inst, d);
      try { if (fs.statSync(sub).isDirectory()) dirs.push(sub); } catch { /* ignore */ }
    }
  } catch { /* none */ }
  let newest = null;
  for (const d of dirs) {
    try { const m = fs.statSync(path.join(d, 'last-status.json')).mtimeMs; if (!newest || m > newest.m) newest = { d, m }; } catch { /* none */ }
  }
  if (newest) {
    const ageMin = Math.round((Date.now() - newest.m) / 60000);
    /** @type {string[]} */
    let keys = [];
    try { keys = Object.keys(JSON.parse(fs.readFileSync(path.join(newest.d, 'last-status.json'), 'utf8')).rate_limits || {}); } catch { /* ignore */ }
    // Defense-in-depth: sanitize the dir + bucket keys before display even
    // though state now lives under the user's own home.
    out.push(ok(`status captured ${ageMin}m ago (${stripControl(newest.d)})`));
    out.push(dim(`  buckets: ${keys.map(stripControl).join(', ') || '(none — API session?)'}`));
  } else {
    out.push(warn('no status captured yet — launch with `ccr` (or `ccr <profile>`) to start capturing'));
  }

  out.push('');
  out.push(problems ? warn(`${problems} thing(s) to address above`) : ok('all good — `ccr` to launch, `ccr economy` for the panel'));
  write(out.join('\n') + '\n');
  return problems ? 1 : 0;
}

module.exports = { run };
