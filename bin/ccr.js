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
  ccr                        plain \`claude\` + sidebar
  ccr c1                     CCS profile c1 + sidebar
  ccr --name side-project    named instance (default name: the repo/dir)
  ccr economy -i side-project  panel for a live instance, by name

Options:
  -h, --help         Show this help
  -v, --version      Show version
      --name <name>  Name this instance (letters, digits, . _ -)
  -i <name>          Target a live instance (economy, sidecar, cycle-view)
      --mary         Enable the mary interface

Sidecar options:
      --view <n>  Open on a view: 0 economy, 1 git, 2+ configured panes
      --keys      Cycle views with F3 or Space, for terminals that bind no key`;

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
        'exit-on-end': { type: 'boolean' },
        name: { type: 'string' },
        instance: { type: 'string', short: 'i' },
        keys: { type: 'boolean' },
        view: { type: 'string' },
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

  // `--view` names a view index, so a non-integer is a typo worth naming rather
  // than a value to coerce: NaN would silently open the economy panel and look
  // like the flag was ignored.
  let view;
  if (values.view != null) {
    view = Number(values.view);
    if (!Number.isInteger(view) || view < 0) {
      process.stderr.write(`ccr: --view takes a view index (0 = economy, 1 = git), got "${values.view}"\n`);
      return 2;
    }
  }

  const cmd = positionals[0];
  // -i is a THREE-command flag: honored where a command must answer "which
  // live instance?", refused LOUDLY everywhere else — the option parser is
  // global, so a silently swallowed -i would let `ccr resume -i x` look
  // targeted while targeting nothing (features/instance-resolution.feature).
  const iTarget = values.instance != null ? values.instance : null;
  if (iTarget != null && !['economy', 'sidecar', 'cycle-view'].includes(cmd || '')) {
    const known = ['economy', 'resume', 'statusline', 'sidecar', 'doctor', 'cycle-view', 'launch'];
    const cname = cmd && known.includes(cmd) ? cmd : 'launch';
    process.stderr.write(`ccr: -i applies to economy, sidecar, cycle-view — ${cname} does not target an instance\n`);
    return 2;
  }
  if (!cmd) return cmdLaunch(undefined, values.name);   // bare `ccr` → launch
  switch (cmd) {
    case 'economy': return cmdEconomy(!!values.json, iTarget);
    case 'resume': return cmdResume(positionals[1]);
    case 'statusline': return cmdStatusline();
    case 'sidecar': return cmdSidecar(values['state-dir'], !!values.hint, !!values['exit-on-end'], !!values.keys, view, iTarget);
    case 'doctor': return require('../src/doctor').run();
    case 'cycle-view': return cmdCycleView(values['state-dir'], iTarget);
    case 'launch': return cmdLaunch(positionals[1], values.name);
    default: return cmdLaunch(cmd, values.name);  // anything else → treat as a CCS profile
  }
}

/**
 * `ccr cycle-view` — show the running sidecar's next view. Bound to a key by
 * the launcher; the sidecar itself reads no input (see src/cycle-view.js).
 * Always exits 0: a keypress that finds no live sidecar is a no-op, not an
 * error worth painting over the user's terminal.
 * @param {string|undefined} stateDirFlag
 * @param {string|null} [target]  -i name, resolved through the chain
 * @returns {number}
 */
function cmdCycleView(stateDirFlag, target = null) {
  let stateDir = stateDirFlag || null;
  if (!stateDir) {
    const res = require('../src/instance-resolve').resolveInstance({ target, command: 'cycle-view' });
    if (!res.ok) { process.stderr.write(res.error + '\n'); return 1; }
    stateDir = res.stateDir;
  }
  require('../src/cycle-view').cycleView(stateDir);
  return 0;
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
    // The identity half: the name this instance chose at launch, and the LIVE
    // location from the status tick's own cwd (features/instance-identity.feature).
    /** @type {{ name?: string|null, location?: string|null }} */
    let identity = {};
    try {
      const naming = require('../src/instance-name');
      const name = fs.readFileSync(path.join(STATE_DIR, naming.NAME_FILE), 'utf8').trim();
      if (name) identity = { name, location: naming.locationFrom(state.cwd) };
    } catch { /* unnamed (explicit override dirs) — no identity segment */ }
    line = renderStatusline(normalizeStatus(state), identity);
    try { ensureSecureDir(STATE_DIR); fs.writeFileSync(SNAPSHOT, raw, { mode: 0o600 }); } catch { /* ignore */ }
    // Burn history is ACCOUNT-scoped and slots are reused, so it lives at the
    // container's top level, never inside an instance dir it would die with.
    try { logMeterSample(state, { dir: path.join(os.homedir(), '.ccr') }); } catch { /* ignore */ }
    // The two-phase join key opens the moment the session id first exists
    // (src/session-log.js) — deaths are when writes can't be trusted.
    try {
      if (state.session_id) {
        const readLocal = (/** @type {string} */ f) => {
          try { return fs.readFileSync(path.join(STATE_DIR, f), 'utf8').trim() || null; } catch { return null; }
        };
        require('../src/session-log').openEntry(os.homedir(), state.session_id, {
          name: readLocal('name'), profile: readLocal('profile'), launch_cwd: readLocal('launch-cwd'),
        });
      }
    } catch { /* ignore */ }
  } catch { /* keep fallback line */ }
  process.stdout.write(line + '\n');
  return 0;
}

/**
 * `ccr economy [--json]` — render the full panel, or with `--json` emit the
 * stable machine-readable economy model (the integration contract). Reads stdin,
 * else the captured snapshot.
 * @param {boolean} [json]
 * @param {string|null} [target]  -i name, resolved through the chain
 * @returns {number}
 */
function cmdEconomy(json, target = null) {
  let raw = readStdin();
  /** @type {string|null} */
  let heading = null;
  if (!raw.trim()) {
    // Which instance? The resolution chain answers, and the panel is headed
    // with the name it resolved to — the safeguard against reading the right
    // panel about the wrong instance.
    const res = require('../src/instance-resolve').resolveInstance({ target, command: 'economy' });
    if (!res.ok) {
      // Zero instances live is not an error: the account's meters and burn
      // history are container-level and still print — only the per-instance
      // panel is gone (features/instance-persistence.feature).
      if ('none' in res && res.none && !json) return printAccountPanel();
      process.stderr.write(res.error + '\n');
      return 1;
    }
    heading = res.name;
    try { raw = fs.readFileSync(path.join(res.stateDir, 'last-status.json'), 'utf8'); } catch { /* none yet */ }
  }
  let state = null;
  if (raw.trim()) { try { state = JSON.parse(raw); } catch { /* bad json */ } }
  if (!state) {
    process.stderr.write('ccr economy: no status captured yet. Run `ccr` (or `ccr <profile>`) to launch + capture.\n');
    return 1;
  }
  const { normalizeStatus } = require('../src/normalize');
  if (json) {
    // The machine contract (docs/JSON-CONTRACT.md) is unchanged: no heading.
    const { computeEconomy } = require('../src/economy-model');
    process.stdout.write(JSON.stringify(computeEconomy(normalizeStatus(state)), null, 2) + '\n');
    return 0;
  }
  const { renderEconomy } = require('../src/render/economy');
  const panel = renderEconomy(normalizeStatus(state));
  process.stdout.write((heading ? heading + '\n' : '') + panel + '\n');
  return 0;
}

/**
 * The zero-instance account view: meters from the newest burn history sample,
 * plus how much history the container retains. No per-instance panel — there
 * is no instance.
 * @returns {number}
 */
function printAccountPanel() {
  const root = path.join(os.homedir(), '.ccr');
  /** @type {{file: string, m: number} | null} */
  let newest = null;
  let sessions = 0;
  try {
    for (const n of fs.readdirSync(root)) {
      if (/^session-[A-Za-z0-9_-]+\.jsonl$/.test(n)) { sessions += 1; continue; }
      if (!/^burnlog-[A-Za-z0-9_-]+\.jsonl$/.test(n)) continue;
      try {
        const m = fs.statSync(path.join(root, n)).mtimeMs;
        if (!newest || m > newest.m) newest = { file: path.join(root, n), m };
      } catch { /* skip */ }
    }
  } catch { /* empty container */ }
  const out = ['account (no live instance)'];
  if (newest) {
    try {
      const lines = fs.readFileSync(newest.file, 'utf8').trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]);
      /** @type {any} */
      const rl = {};
      for (const [k, v] of Object.entries(last.limits || {})) {
        rl[k] = { used_percentage: /** @type {any} */ (v).used, resets_at: /** @type {any} */ (v).resets_at };
      }
      const { normalizeStatus } = require('../src/normalize');
      const { renderEconomy } = require('../src/render/economy');
      out.push(renderEconomy(normalizeStatus({ rate_limits: rl })));
    } catch { out.push('meters unreadable'); }
  } else {
    out.push('no burn history captured yet');
  }
  out.push(`history: ${sessions} session${sessions === 1 ? '' : 's'} retained`);
  process.stdout.write(out.join('\n') + '\n');
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
 * `--exit-on-end` closes the panel shortly after the session ends (the Windows
 * Terminal launcher passes it so its `cmd /c` pane sweeps closed like tmux).
 * `--view <n>` opens on a chosen view (0 economy, 1 git, 2…N configured panes).
 *
 * `--keys` makes THIS process the hotkey host and runs the panel as a child, for
 * terminals that bind no key of their own (VS Code and its forks). The renderer
 * still never reads input — see the header of src/sidecar-keys.js for why that
 * separation is the whole point, and why it is a child rather than a listener.
 *
 * @param {string | undefined} stateDir
 * @param {boolean} [showHint]
 * @param {boolean} [exitOnEnd]
 * @param {boolean} [useKeys]
 * @param {number} [view]
 * @param {string|null} [target]  -i name, resolved through the chain
 * @returns {number | undefined}
 */
function cmdSidecar(stateDir, showHint, exitOnEnd, useKeys, view, target = null) {
  // Resolve whether or not -i was typed, which is what `ccr cycle-view` has
  // always done. Consulting the chain ONLY for -i meant a bare `ccr sidecar`
  // skipped every other link in it — including the one that matters most here,
  // "the live instance whose launch directory contains the cwd" — and landed on
  // the CONTAINER (~/.ccr) instead. The container holds no session, so the pane
  // sat empty next to a running instance, and the fix looked like naming the
  // instance exactly right when the whole point of the chain is not having to.
  //
  // --hint is left out: it prints the VS Code split instructions, which are
  // worth printing before any instance exists, so requiring a live one to
  // explain how to start one would be backwards.
  if (!stateDir && !showHint) {
    const res = require('../src/instance-resolve').resolveInstance({ target, command: 'sidecar' });
    if (!res.ok) { process.stderr.write(res.error + '\n'); return 1; }
    stateDir = res.stateDir;
  }
  if (stateDir) process.env.CCR_STATE_DIR = stateDir;
  if (showHint) return require('../src/launch-vscode').hint(process.env.CCR_STATE_DIR || STATE_DIR);
  if (useKeys) {
    require('../src/sidecar-keys').runWithKeys({
      stateDir: process.env.CCR_STATE_DIR || STATE_DIR,
      // This very file, so the child is the same ccr the user invoked — not
      // whatever `ccr` happens to resolve to on the child's PATH.
      ccrJs: __filename,
      argv: [
        ...(exitOnEnd ? ['--exit-on-end'] : []),
        ...(view != null ? ['--view', String(view)] : []),
      ],
    });
    return undefined;
  }
  require('../src/sidecar').run({ exitOnEnd: !!exitOnEnd, view });
  return undefined;
}

/**
 * `ccr [profile]` — launch the live sidecar. Inside VS Code's integrated terminal
 * we split it in place (Windows always; other OSes via CCR_VSCODE=1, since tmux
 * already works there); on native Windows we drive Windows Terminal; otherwise
 * the tmux launcher (scripts/launch.sh).
 * @param {string | undefined} profile
 * @param {string} [name]  explicit instance name (--name); validated here
 * @returns {number}
 */
function cmdLaunch(profile, name) {
  // An explicit name is REJECTED, never repaired: the user typed it and a
  // human is right there — matching the launcher's profile-name message shape
  // (features/instance-naming.feature).
  const naming = require('../src/instance-name');
  if (name != null && !naming.NAME_RE.test(name)) {
    process.stderr.write(`ccr: invalid instance name '${name}' (allowed: letters, digits, . _ -)\n`);
    return 1;
  }
  // Migration runs AT LAUNCH ONLY — never from `ccr statusline`, which Claude
  // invokes headlessly mid-session (src/migrate.js). A refused migration is a
  // refused launch: proceeding would write new-layout state into an old home.
  const mig = require('../src/migrate').ensureLayout();
  if (!mig.ok) { process.stderr.write(mig.error + '\n'); return 1; }
  // Shared across ALL launchers (a platform must never ship half-lit): the
  // explicit-name collision refusal, and the retention boundary.
  const live = naming.liveNames({ home: os.homedir() });
  if (name != null && live.has(name)) {
    process.stderr.write(`ccr: instance name '${name}' is already live — pick another\n`);
    return 1;
  }
  try { require('../src/session-log').pruneHistory(os.homedir()); } catch { /* best effort */ }
  const inVscode = process.env.TERM_PROGRAM === 'vscode';
  if (inVscode && (process.platform === 'win32' || process.env.CCR_VSCODE === '1')) {
    return require('../src/launch-vscode').run(profile, undefined, { name });
  }
  if (process.platform === 'win32') {
    return require('../src/launch-win').run(profile, undefined, { name });
  }
  const { spawnSync } = require('node:child_process');
  const launcher = path.join(__dirname, '..', 'scripts', 'launch.sh');
  // Every launch gets a free instance slot — bare or profiled — so a second
  // terminal never collides with the first (src/instance-slot.js). The
  // launcher needs no knowledge of slots: it already derives session, socket
  // and state dir from these two vars.
  const slots = require('../src/instance-slot');
  const slot = slots.allocateSlot({ profile });
  if (slot && 'exhausted' in slot) {
    process.stderr.write(`ccr: every slot is in use (${slots.MAX_SLOTS} live instances) — close one first\n`);
    return 1;
  }
  // Name + profile record + title, the same way every launcher does it.
  const inst = slot && !('exhausted' in slot)
    ? naming.prepareInstance(slot, { profile, name }) : null;
  let env = slots.applySlotEnv(process.env, slot);
  // The tab's ADDRESS, composed once here and never retitled mid-session.
  if (inst) env = { ...env, CCR_TITLE: inst.title };
  // This call blocks for the session's whole lifetime (launch.sh ends in `tmux
  // attach`), which is exactly why this process is what owns the slot.
  const r = spawnSync('bash', profile ? [launcher, profile] : [launcher], { stdio: 'inherit', env });
  // Ephemeral instances: a polite exit deletes the instance dir, unless an
  // attached sidebar is still reading it (then the dir waits for reuse).
  if (slot && !('exhausted' in slot)) slots.retireInstance(slot.stateDir);
  if (r.error) { process.stderr.write(`ccr: launch failed: ${r.error.message}\n`); return 1; }
  return typeof r.status === 'number' ? r.status : 1;
}

const code = main(process.argv.slice(2));
if (typeof code === 'number') process.exit(code);
