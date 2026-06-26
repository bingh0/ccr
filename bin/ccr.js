#!/usr/bin/env node
// @ts-check
'use strict';
// bin/ccr.js — ccr CLI + launcher. Pure Node, zero runtime deps.
//
//   ccr            launch `claude` + economy sidebar (tmux)
//   ccr <profile>  launch CCS profile + sidebar (e.g. `ccr c1`)
//   ccr economy    print the economy panel from the latest captured status
//   ccr economy --json  emit the machine-readable economy model (see docs/JSON-CONTRACT.md)
//   ccr statusline emit one-line status (wired via --settings at launch)
//   ccr sidecar    run the live economy panel (used inside the tmux session)

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseArgs } = require('node:util');
const pkg = require('../package.json');

// Per-session state dir (the launcher sets CCR_STATE_DIR per profile); default
// ~/.ccr for ad-hoc use. Always under the user's home — never world-shared /tmp.
const STATE_DIR = process.env.CCR_STATE_DIR || path.join(os.homedir(), '.ccr');
const SNAPSHOT = path.join(STATE_DIR, 'last-status.json');
const MAX_SNAPSHOT_BYTES = 1_000_000; // a status JSON is a few KB; cap to bound parse/disk

const HELP = `ccr — Claude Code run-rate (v${pkg.version})

Usage:
  ccr [profile]    Launch Claude (or a CCS profile) with the live economy sidebar
  ccr economy      Print the economy panel from the latest captured status
  ccr economy --json   Emit the machine-readable economy model (stable contract)
  ccr resume       Recent sessions ranked by cost to resume (advisor)
  ccr statusline   Emit one-line status (wired automatically at launch)
  ccr sidecar      Run the live economy panel (used inside the tmux session)
  ccr doctor       Check your local setup (node, tmux, CCS, capture status)

Examples:
  ccr              plain \`claude\` + sidebar
  ccr c1           CCS profile c1 + sidebar
  ccr economy      one-off panel

Options:
  -h, --help     Show this help
  -v, --version  Show version
      --mary     Enable the mary interface`;

/**
 * @param {string[]} argv
 * @returns {number | undefined} exit code; undefined keeps the process alive (sidecar)
 */
function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        json: { type: 'boolean' },
        'state-dir': { type: 'string' },
        hint: { type: 'boolean' },
        mary: { type: 'boolean' },
      },
    });
  } catch (err) {
    process.stderr.write(`ccr: ${err instanceof Error ? err.message : String(err)}\n\n${HELP}\n`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.version) { process.stdout.write(`${pkg.version}\n`); return 0; }
  if (values.help) { process.stdout.write(`${HELP}\n`); return 0; }
  // The mary interface is an env toggle under the hood; surface it as a flag so
  // in-process panels (economy/statusline/resume) pick it up for this run.
  if (values.mary) process.env.CCR_ENABLE_MARY_INTERFACE = '1';

  const cmd = positionals[0];
  if (!cmd) return cmdLaunch(undefined);          // bare `ccr` → launch
  switch (cmd) {
    case 'economy': return cmdEconomy(!!values.json);
    case 'resume': return cmdResume(positionals[1]);
    case 'statusline': return cmdStatusline();
    case 'sidecar': return cmdSidecar(values['state-dir'], !!values.hint);
    case 'doctor': return require('../src/doctor').run();
    case 'launch': return cmdLaunch(positionals[1]);
    default: return cmdLaunch(cmd);               // anything else → treat as a CCS profile
  }
}

function readStdin() {
  try { return process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

/**
 * `ccr statusline` — reads status JSON on stdin, persists the snapshot, logs a
 * meter sample, prints a compact line. MUST never throw.
 * @returns {number}
 */
function cmdStatusline() {
  const raw = readStdin();
  let line = 'ccr';
  // Bound input: a real status JSON is a few KB. Refuse to parse/persist an
  // absurdly large blob (keeps the status line cheap and the snapshot small).
  if (raw.length > MAX_SNAPSHOT_BYTES) { process.stdout.write(line + '\n'); return 0; }
  try {
    const state = JSON.parse(raw);
    const { normalizeStatus } = require('../src/normalize');
    const { renderStatusline } = require('../src/render/statusline');
    const { logMeterSample } = require('../src/instrument');
    const { ensureSecureDir } = require('../src/state-dir');
    line = renderStatusline(normalizeStatus(state));
    try { ensureSecureDir(STATE_DIR); fs.writeFileSync(SNAPSHOT, raw, { mode: 0o600 }); } catch { /* ignore */ }
    try { logMeterSample(state, { dir: STATE_DIR }); } catch { /* ignore */ }
  } catch { /* keep fallback line */ }
  process.stdout.write(line + '\n');
  return 0;
}

/**
 * `ccr economy [--json]` — render the full panel, or with `--json` emit the
 * stable machine-readable economy model (the integration contract). Reads stdin,
 * else the captured snapshot.
 * @param {boolean} [json]
 * @returns {number}
 */
function cmdEconomy(json) {
  let raw = readStdin();
  if (!raw.trim()) { try { raw = fs.readFileSync(SNAPSHOT, 'utf8'); } catch { /* none yet */ } }
  let state = null;
  if (raw.trim()) { try { state = JSON.parse(raw); } catch { /* bad json */ } }
  if (!state) {
    process.stderr.write('ccr economy: no status captured yet. Run `ccr` (or `ccr <profile>`) to launch + capture.\n');
    return 1;
  }
  const { normalizeStatus } = require('../src/normalize');
  if (json) {
    const { computeEconomy } = require('../src/economy-model');
    process.stdout.write(JSON.stringify(computeEconomy(normalizeStatus(state)), null, 2) + '\n');
    return 0;
  }
  const { renderEconomy } = require('../src/render/economy');
  process.stdout.write(renderEconomy(normalizeStatus(state)) + '\n');
  return 0;
}

/**
 * `ccr resume [all]` — advisor: recent sessions ranked by cost to resume. Default
 * scope is the current project; `all` widens to every project. Read-only; you pick
 * with `claude --resume`.
 * @param {string | undefined} arg
 * @returns {number}
 */
function cmdResume(arg) {
  const scope = (arg === 'all' || arg === '--all') ? 'all' : 'cwd';
  const { gather } = require('../src/resume');
  const { renderResume } = require('../src/render/resume');
  process.stdout.write(renderResume(gather({ scope, cwd: process.cwd() }), { scope }) + '\n');
  return 0;
}

/**
 * `ccr sidecar` — live economy panel; keeps the process alive (no exit code).
 * `--state-dir <dir>` targets a specific session (used by the VS Code split-pane
 * one-liner, which is shell-agnostic). `--hint` reprints the VS Code split
 * instructions + re-copies the one-liner instead of running the panel.
 * @param {string | undefined} stateDir
 * @param {boolean} [showHint]
 * @returns {number | undefined}
 */
function cmdSidecar(stateDir, showHint) {
  if (stateDir) process.env.CCR_STATE_DIR = stateDir;
  if (showHint) return require('../src/launch-vscode').hint(process.env.CCR_STATE_DIR || STATE_DIR);
  require('../src/sidecar').run();
  return undefined;
}

/**
 * `ccr [profile]` — launch the live sidecar. Inside VS Code's integrated terminal
 * we split it in place (Windows always; other OSes via CCR_VSCODE=1, since tmux
 * already works there); on native Windows we drive Windows Terminal; otherwise
 * the tmux launcher (scripts/launch.sh).
 * @param {string | undefined} profile
 * @returns {number}
 */
function cmdLaunch(profile) {
  const inVscode = process.env.TERM_PROGRAM === 'vscode';
  if (inVscode && (process.platform === 'win32' || process.env.CCR_VSCODE === '1')) {
    return require('../src/launch-vscode').run(profile);
  }
  if (process.platform === 'win32') {
    return require('../src/launch-win').run(profile);
  }
  const { spawnSync } = require('node:child_process');
  const launcher = path.join(__dirname, '..', 'scripts', 'launch.sh');
  const r = spawnSync('bash', profile ? [launcher, profile] : [launcher], { stdio: 'inherit' });
  if (r.error) { process.stderr.write(`ccr: launch failed: ${r.error.message}\n`); return 1; }
  return typeof r.status === 'number' ? r.status : 1;
}

const code = main(process.argv.slice(2));
if (typeof code === 'number') process.exit(code);
