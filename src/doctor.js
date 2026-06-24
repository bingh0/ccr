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

/** @returns {number} exit code (0 = healthy) */
function run() {
  const REPO = path.join(__dirname, '..');
  const isWin = process.platform === 'win32';
  const out = [bold('ccr doctor'), ''];
  let problems = 0;

  const [maj, min] = process.versions.node.split('.').map(Number);
  const nodeOk = maj > 18 || (maj === 18 && min >= 3);
  out.push(nodeOk ? ok(`node ${process.version}`) : bad(`node ${process.version} — need >= 18.3`));
  if (!nodeOk) problems++;

  const ccr = has('ccr');
  out.push(ccr ? ok(`ccr on PATH (${stripControl(ccr)})`) : warn('ccr not on PATH — run `npm link` in the repo'));
  if (!ccr) problems++;

  if (isWin) {
    // The live sidebar (tmux + bash) is WSL-only on native Windows — by design,
    // not a problem. Say so plainly so a Windows user isn't told to "fix" it.
    out.push(dim('· live sidebar (`ccr`) needs tmux + bash — for that, use WSL2.'));
    out.push(dim('  The CLI (economy / statusline / resume / doctor) runs natively here.'));
  } else {
    const tmux = has('tmux');
    out.push(tmux ? ok(`tmux (${stripControl(tmux)})`) : warn('tmux missing — needed for `ccr [profile]` sidebar (use WSL on Windows)'));
    if (!tmux) problems++;
    out.push(has('bash') ? ok('bash') : warn('bash missing — needed for the launcher'));

    const sl = path.join(REPO, 'sidecar', 'ccr-statusline');
    out.push(isExec(sl) ? ok('sidecar/ccr-statusline is executable') : warn('sidecar/ccr-statusline not executable (the launcher self-heals this)'));
  }

  const ccs = has('ccs');
  if (ccs) {
    let profiles = [];
    try { profiles = fs.readdirSync(path.join(os.homedir(), '.ccs', 'instances')).filter((p) => !p.startsWith('.')); } catch { /* none */ }
    // Profile + path come from the filesystem; sanitize before display.
    out.push(ok(`ccs (${stripControl(ccs)}) · profiles: ${profiles.map(stripControl).join(', ') || '(none)'}`));
  } else {
    out.push(dim('· ccs not installed (optional — only for `ccr <profile>`)'));
  }

  // newest captured snapshot across ~/.ccr and its per-profile subdirs (state
  // lives under the user's home now, never world-shared /tmp).
  const ccrDir = path.join(os.homedir(), '.ccr');
  const dirs = [ccrDir];
  try {
    for (const d of fs.readdirSync(ccrDir)) {
      const sub = path.join(ccrDir, d);
      try { if (fs.statSync(sub).isDirectory()) dirs.push(sub); } catch { /* ignore */ }
    }
  } catch { /* none */ }
  let newest = null;
  for (const d of dirs) {
    try { const m = fs.statSync(path.join(d, 'last-status.json')).mtimeMs; if (!newest || m > newest.m) newest = { d, m }; } catch { /* none */ }
  }
  if (newest) {
    const ageMin = Math.round((Date.now() - newest.m) / 60000);
    let keys = [];
    try { keys = Object.keys(JSON.parse(fs.readFileSync(path.join(newest.d, 'last-status.json'), 'utf8')).rate_limits || {}); } catch { /* ignore */ }
    // Defense-in-depth: sanitize the dir + bucket keys before display even
    // though state now lives under the user's own home.
    out.push(ok(`status captured ${ageMin}m ago (${stripControl(newest.d)})`));
    out.push(dim(`  buckets: ${keys.map(stripControl).join(', ') || '(none — API session?)'}`));
  } else {
    out.push(warn(isWin
      ? 'no status captured yet — wire `ccr statusline` into Claude Code (settings.json) to start capturing'
      : 'no status captured yet — launch with `ccr` (or `ccr <profile>`) to start capturing'));
  }

  out.push('');
  const allGood = isWin
    ? 'all good — `ccr economy` for the panel, `ccr statusline` to wire into CC'
    : 'all good — `ccr` to launch, `ccr economy` for the panel';
  out.push(problems ? warn(`${problems} thing(s) to address above`) : ok(allGood));
  process.stdout.write(out.join('\n') + '\n');
  return problems ? 1 : 0;
}

module.exports = { run };
