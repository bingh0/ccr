// @ts-check
'use strict';
// Step definitions for features/instance-identity.feature.
//
// Title scenarios run the REAL CLI: the stub session echoes CCR_TITLE, the
// one artifact the launcher composes for the terminal. Status-line scenarios
// pipe a real status JSON through `ccr statusline` with the instance's name
// file in place — the exact seam Claude Code drives per render. Only the
// fixed-width ellipsis scenario binds at renderStatusline directly, because
// the CLI surface carries no column count.

const assert = require('node:assert');
const { refuteWithControl } = require('./_absence');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const slots = require('../../src/instance-slot');

const CCR_JS = path.join(__dirname, '..', '..', 'bin', 'ccr.js');

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineInstanceIdentitySteps(reg) {
  const home = (/** @type {Record<string, any>} */ w) => {
    if (!w.home) {
      w.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-ident-'));
      w.home = path.join(w.root, 'home');
      const bin = path.join(w.root, 'bin');
      fs.mkdirSync(w.home, { recursive: true });
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'bash'),
        '#!/bin/sh\necho "title=$CCR_TITLE"\n', { mode: 0o755 });
      w.bin = bin;
      fs.mkdirSync(path.join(w.home, '.ccr'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(w.home, '.ccr', '.layout'), '1\n');
      w.defer(() => fs.rmSync(w.root, { recursive: true, force: true }));
    }
    return w.home;
  };

  const makeRepo = (/** @type {Record<string, any>} */ w, /** @type {string} */ name) => {
    const dir = path.join(home(w), 'trees', name);
    const git = path.join(dir, '.git', 'refs', 'heads');
    fs.mkdirSync(git, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(git, 'main'), '9749285e1c0a4b2d3f5e6a7b8c9d0e1f2a3b4c5d\n');
    return dir;
  };

  const T5 = Math.floor(Date.now() / 1000) + 14_400;
  const TW = Math.floor(Date.now() / 1000) + 500_000;

  /** A status JSON as Claude emits it, with a controllable live cwd. */
  const statusJson = (/** @type {Record<string, any>} */ w, /** @type {{cwd?: string, imminent?: boolean}} */ o = {}) => JSON.stringify({
    model: { display_name: 'Opus 4.8' },
    cwd: o.cwd || w.launchCwd || home(w),
    context_window: { context_window_size: 200000, total_input_tokens: 82000 },
    rate_limits: {
      // "Imminent" = the binding window's projected minutes-left ≤ 30: 90%
      // used with 60 minutes to reset projects ~27 minutes left.
      five_hour: { used_percentage: o.imminent ? 90 : 20, resets_at: o.imminent ? Math.floor(Date.now() / 1000) + 3600 : T5 },
      seven_day: { used_percentage: 18, resets_at: TW },
    },
    cost: { total_cost_usd: 2.5 },
  });

  /** Launch the real CLI (title scenarios): stub session reports CCR_TITLE. */
  const launch = (/** @type {Record<string, any>} */ w, /** @type {string[]} */ args = []) => {
    if (process.platform === 'win32') {
      // Same product functions in-process (see the naming steps' note): the
      // title is what prepareInstance composes; its delivery to the terminal
      // is pinned per-launcher (tmux: CCR_TITLE literal; wt: --title arg,
      // test/launch-win-run.test.js).
      const naming = require('../../src/instance-name');
      const nameIx = args.indexOf('--name');
      const explicit = nameIx >= 0 ? args[nameIx + 1] : null;
      const profile = args.find((a, i) => !a.startsWith('-') && (nameIx < 0 || i !== nameIx + 1));
      const slot = slots.allocateSlot({ env: {}, home: home(w) });
      if (!slot || 'exhausted' in slot) { w.title = ''; return; }
      const inst = naming.prepareInstance(slot, { profile, name: explicit, cwd: w.launchCwd || home(w), home: home(w) });
      w.title = inst.title;
      slots.retireInstance(slot.stateDir, { home: home(w), sidecarAlive: () => false });
      return;
    }
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, HOME: home(w), USERPROFILE: home(w), PATH: `${w.bin}${path.delimiter}${process.env.PATH}` };
    delete env.CCR_SESSION;
    delete env.CCR_STATE_DIR;
    delete env.TERM_PROGRAM;
    const r = spawnSync(process.execPath, [CCR_JS, ...args], { env, encoding: 'utf8', cwd: w.launchCwd || home(w) });
    const m = /title=(.*)/.exec(String(r.stdout || ''));
    w.title = m ? m[1].trim() : '';
  };

  /** Render the real status line (statusline scenarios) through the CLI seam. */
  const renderLine = (/** @type {Record<string, any>} */ w, /** @type {string} */ input) => {
    const stateDir = path.join(home(w), '.ccr', 'instances', '7');
    fs.mkdirSync(stateDir, { recursive: true });
    if (w.name) fs.writeFileSync(path.join(stateDir, 'name'), w.name + '\n');
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, HOME: home(w), USERPROFILE: home(w), CCR_STATE_DIR: stateDir };
    const r = spawnSync(process.execPath, [CCR_JS, 'statusline'], { env, encoding: 'utf8', input });
    w.line = String(r.stdout || '').trim();
  };

  // --- Givens ---

  reg.define(/^a bare ccr launched from repository "([^"]+)"$/, (w, name) => {
    w.launchCwd = makeRepo(w, String(name));
  });

  reg.define(/^ccr launched with CCS profile "cc1" from repository "([^"]+)"$/, (w, name) => {
    w.launchCwd = makeRepo(w, String(name));
    w.profileArgs = ['cc1'];
  });

  reg.define(/^ccr launched from repository "([^"]+)" with --name "([^"]+)"$/, (w, repo, name) => {
    w.launchCwd = makeRepo(w, String(repo));
    w.nameArgs = ['--name', name];
  });

  reg.define(/^ccr launched with CCS profile "cc1" and --name "([^"]+)"$/, (w, name) => {
    w.launchCwd = makeRepo(w, 'a');
    w.profileArgs = ['cc1'];
    w.nameArgs = ['--name', name];
  });

  reg.define(/^an instance titled "a" whose session has changed directory into repository "b"$/, (w) => {
    w.launchCwd = makeRepo(w, 'a');
    makeRepo(w, 'b');
  });

  reg.define(/^an instance named "([^"]+)" launched in repository "([^"]+)"$/, (w, name, repo) => {
    w.name = name;
    w.launchCwd = makeRepo(w, String(repo));
  });

  reg.define(/^an instance named "([^"]+)" in repository "([^"]+)"$/, (w, name, repo) => {
    w.name = name;
    w.launchCwd = makeRepo(w, String(repo));
  });

  reg.define(/^the session has changed directory into repository "([^"]+)"$/, (w, repo) => {
    w.currentCwd = makeRepo(w, String(repo));
  });

  reg.define(/^the binding window has 20 minutes left$/, (w) => {
    w.imminent = true;
  });

  reg.define(/^a bare ccr launched from directory "~\/notes"$/, (w) => {
    w.launchCwd = path.join(home(w), 'notes');
    fs.mkdirSync(w.launchCwd, { recursive: true });
    w.name = 'notes';
  });

  reg.define(/^an instance named "([^"]+)"$/, (w, name) => {
    w.name = name;
  });

  // --- Whens ---

  reg.define(/^the terminal title is composed$/, (w) => {
    launch(w, [...(w.profileArgs || []), ...(w.nameArgs || [])]);
  });

  reg.define(/^the terminal title is observed after the move$/, (w) => {
    // The title was composed at launch; the "move" leaves nothing to re-run.
    // The product holds no retitle path at all: set-titles-string appears
    // exactly once, in the launcher, as a literal — asserted below.
    launch(w);
    const sh = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'launch.sh'), 'utf8');
    const settingIt = sh.split('\n').filter((l) => /^\s*tmux .*set-titles-string/.test(l));
    assert.strictEqual(settingIt.length, 1, 'one composition point, in the launcher');
    assert.match(settingIt[0], /"\$CCR_TITLE"/, 'a literal, never a tmux format that follows the session');
    // Witness: the real OSC title sequences. ccr sets its title through tmux's
    // set-titles-string alone, so nothing in src may emit one directly — and a
    // needle that stopped naming those sequences would certify that silently.
    const OSC_TITLE = '\x1b]0;a title\x07 and \x1b]2;another\x07';
    for (const f of fs.readdirSync(path.join(__dirname, '..', '..', 'src'))) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8');
      refuteWithControl(/\]0;|\]2;/, src, OSC_TITLE, `${f} must not emit an OSC title`);
    }
  });

  reg.define(/^the status line renders$/, (w) => {
    // The bare-launch scenarios derive the name the launcher would have
    // written; the named scenarios set it explicitly.
    if (!w.name) w.name = path.basename(w.launchCwd);
    renderLine(w, statusJson(w, { cwd: w.currentCwd || w.launchCwd, imminent: !!w.imminent }));
  });

  reg.define(/^the status line renders into 34 columns$/, (w) => {
    const { renderStatusline } = require('../../src/render/statusline');
    const { normalizeStatus } = require('../../src/normalize');
    const state = JSON.parse(statusJson(w, { cwd: w.launchCwd }));
    const render = (/** @type {number} */ cols) => renderStatusline(normalizeStatus(state), {
      name: w.name, location: 'docs-mirror', cols,
    });
    w.line = render(34);
    w.lineAgain = render(34);
    // The control arm for the ellipsis Then: the same render given room shows
    // the name whole. Without it, "the full name is absent" is equally true of
    // a name this step has misspelt.
    w.lineRoomy = render(200);
  });

  reg.define(/^its sidebar draws$/, (w) => {
    const { composeFrame } = require('../../src/sidecar');
    const stateDir = path.join(home(w), '.ccr', 'instances', '3');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'name'), w.name + '\n');
    w.frame = composeFrame(stateDir, { home: home(w), cols: 48 });
  });

  // --- Thens ---

  reg.define(/^the terminal title is "([^"]+)"$/, (w, title) => {
    assert.strictEqual(w.title, title);
  });

  reg.define(/^the terminal title is still "([^"]+)"$/, (w, title) => {
    assert.strictEqual(w.title, title);
  });

  reg.define(/^the status line begins with "(.+)"$/, (w, prefix) => {
    assert.ok(w.line.startsWith(prefix), `expected ${JSON.stringify(w.line)} to begin with ${JSON.stringify(prefix)}`);
  });

  reg.define(/^the status line does not contain "([^"]+)"$/, (w, s) => {
    assert.ok(!w.line.includes(s), `expected ${JSON.stringify(w.line)} not to contain ${JSON.stringify(s)}`);
  });

  reg.define(/^the imminent-limit marker appears before "([^"]+)"$/, (w, name) => {
    const warn = w.line.indexOf('⚠');
    const at = w.line.indexOf(name);
    assert.ok(warn >= 0, `expected the ⚠ marker in ${JSON.stringify(w.line)}`);
    assert.ok(at > warn, 'the warning outranks the identity');
  });

  reg.define(/^the identity shows "([^"]+)" in full$/, (w, loc) => {
    assert.ok(w.line.includes(`@ ${loc}`), w.line);
  });

  reg.define(/^the instance name is shortened with an ellipsis$/, (w) => {
    assert.ok(w.line.includes('…'), w.line);
    refuteWithControl(w.name, w.line, w.lineRoomy,
      `the full name cannot fit at 34 columns: ${w.line}`);
  });

  reg.define(/^a second render of the same state is identical to the first$/, (w) => {
    assert.strictEqual(w.lineAgain, w.line, 'nothing slides, blinks or alternates');
  });

  reg.define(/^the sidebar shows the name "([^"]+)"$/, (w, name) => {
    assert.ok(w.frame.includes(name), `expected the frame to carry ${JSON.stringify(name)}`);
  });
};
