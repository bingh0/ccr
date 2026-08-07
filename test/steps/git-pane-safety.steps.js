// @ts-check
'use strict';
// Step definitions for features/git-pane-safety.feature.
//
// The subject is the trust boundary, so the assertions run against the RAW
// frame — SGR runs and all — because "emits no escape sequence taken from that
// subject" is a claim about bytes, and stripping colour first would strip the
// evidence. The planted sequences are ones ccr itself never emits (clear-screen,
// OSC title), so their absence is attributable: ccr's own colouring cannot
// mask a leak.
//
// The wedging and cycling scenarios run through the sidecar's production tick
// (`frame`) and the real request file the host's key writes, exactly like
// test/steps/git-pane-placement.steps.js — a redraw that "survives" through a
// bare composeFrame call would prove the renderer, not the sidebar.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { composeFrame, frame, __resetViewState } = require('../../src/sidecar');
const { cycleView } = require('../../src/cycle-view');
const { buildWorkRepo, writeTrees, writeCommit } = require('./_git-fixture');

/** The view index the git pane occupies (economy is 0). */
const GIT_VIEW = 1;

/** Sequences ccr never emits, planted so a leak is attributable. */
const CLEAR_SCREEN = '\x1b[2J';
const OSC_TITLE = '\x1b]0;owned\x07';

/** Builtins that would give the pane a capability beyond drawing. */
const FORBIDDEN_BUILTINS = [
  'child_process', 'net', 'http', 'https', 'dgram', 'tls', 'worker_threads',
  'vm', 'repl', 'cluster', 'inspector',
];

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineGitPaneSafetySteps(reg) {
  const world = (/** @type {Record<string, any>} */ w) => {
    if (!w.root) {
      w.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-safety-'));
      w.defer(() => fs.rmSync(w.root, { recursive: true, force: true }));
      w.stateDir = path.join(w.root, 'state');
      fs.mkdirSync(w.stateDir, { recursive: true });
      __resetViewState();
      w.defer(() => __resetViewState());
    }
    return w;
  };

  /** Point the launcher and status files at a repo, with meters for economy. */
  const target = (/** @type {Record<string, any>} */ w, /** @type {string} */ repo) => {
    const nowSec = Math.floor(Date.now() / 1000);
    fs.writeFileSync(path.join(w.stateDir, 'launch-cwd'), repo + '\n');
    fs.writeFileSync(path.join(w.stateDir, 'last-status.json'), JSON.stringify({
      model: { display_name: 'Opus 5' },
      workspace: { current_dir: repo, project_dir: repo },
      cwd: repo,
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: nowSec + 3 * 3600 },
        seven_day: { used_percentage: 18, resets_at: nowSec + 4 * 86400 },
      },
      context_window: { context_window_size: 1000000, total_input_tokens: 120000 },
      cost: { total_cost_usd: 3.25, total_duration_ms: 45 * 60 * 1000 },
    }));
  };

  const compose = (/** @type {Record<string, any>} */ w, /** @type {number} */ view) =>
    composeFrame(w.stateDir, { now: Date.now(), view, cols: 60, rows: 30, panes: [] });

  /** One production tick: the draw loop's own reader-and-painter pair. */
  const tick = (/** @type {Record<string, any>} */ w) => {
    let painted = '';
    frame({
      stateDir: w.stateDir,
      compose: (/** @type {string} */ dir, /** @type {any} */ opts) => composeFrame(dir, { ...opts, cols: 60, rows: 30, panes: [] }),
      paint: (/** @type {string} */ s) => { painted = s; },
    });
    return painted;
  };

  /** Recursive listing with sizes and mtimes — "no file created, changed or
   * deleted" compared as data, not as a feeling. */
  const snapshot = (/** @type {string} */ dir) => {
    /** @type {string[]} */
    const out = [];
    (function walk(/** @type {string} */ d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = path.join(d, e.name);
        const st = fs.lstatSync(p);
        out.push(`${path.relative(dir, p)} ${st.isDirectory() ? 'dir' : st.size + ' ' + st.mtimeMs}`);
        if (e.isDirectory()) walk(p);
      }
    })(dir);
    return out;
  };

  // ── Given ─────────────────────────────────────────────────────────────────

  reg.define(/^the newest commit's subject contains a terminal escape sequence$/, (w) => {
    world(w);
    const repo = path.join(w.root, 'repo');
    const git = path.join(repo, '.git');
    fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
    fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
    w.subjectParts = ['before', 'after'];
    const subject = `${w.subjectParts[0]} ${CLEAR_SCREEN}${OSC_TITLE} ${w.subjectParts[1]}`;
    const tip = writeCommit(git, writeTrees(git, new Map()), {
      message: subject, when: Math.floor(Date.now() / 1000) - 3600,
    });
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(git, 'refs', 'heads', 'main'), tip + '\n');
    target(w, repo);
  });

  reg.define(/^the checked-out branch name contains a terminal escape sequence$/, (w) => {
    world(w);
    const repo = path.join(w.root, 'repo');
    const git = path.join(repo, '.git');
    fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
    fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
    // The HEAD file is attacker-writable state; the branch name it carries
    // arrives with a live escape. No ref file needs to exist for the identity
    // row to display the name — which is exactly the path under test.
    fs.writeFileSync(path.join(git, 'HEAD'), `ref: refs/heads/red${CLEAR_SCREEN}alert\n`);
    target(w, repo);
  });

  reg.define(/^the repo's git data cannot be read$/, (w) => {
    world(w);
    const repo = path.join(w.root, 'repo');
    const git = path.join(repo, '.git');
    fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
    fs.mkdirSync(path.join(git, 'refs'), { recursive: true });
    // A HEAD that is neither a ref line nor an object id: located, unreadable.
    fs.writeFileSync(path.join(git, 'HEAD'), 'this is not a HEAD\n');
    target(w, repo);
  });

  reg.define(/^the git pane is showing the repo "([^"]+)"$/, (w, name) => {
    world(w);
    w.repo = buildWorkRepo(path.join(w.root, name), {
      committed: { 'README.md': `# ${name}\n` },
    });
    target(w, w.repo);
    // The premise, checked: the pane really is up and naming this repo.
    const p = compose(w, GIT_VIEW).replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok((p.split('\n')[0] || '').includes(name),
      `the pane should be showing "${name}"; got:\n${p}`);
  });

  // ── When ──────────────────────────────────────────────────────────────────

  reg.define(/^the git pane renders$/, (w) => {
    w.frame = compose(world(w), GIT_VIEW);
    w.plain = w.frame.replace(/\x1b\[[0-9;]*m/g, '');
  });

  reg.define(/^the git pane renders (\d+) times$/, (w, n) => {
    world(w);
    w.before = snapshot(w.repo);
    for (let i = 0; i < Number(n); i += 1) w.frame = compose(w, GIT_VIEW);
    w.plain = w.frame.replace(/\x1b\[[0-9;]*m/g, '');
  });

  reg.define(/^the repo directory is deleted$/, (w) => {
    fs.rmSync(w.repo, { recursive: true, force: true });
  });

  reg.define(/^the git pane redraws$/, (w) => {
    w.frame = compose(world(w), GIT_VIEW);
    w.plain = w.frame.replace(/\x1b\[[0-9;]*m/g, '');
  });

  // ── Then ──────────────────────────────────────────────────────────────────

  reg.define(/^the pane emits no escape sequence taken from that subject$/, (w) => {
    assert.ok(!w.frame.includes(CLEAR_SCREEN) && !w.frame.includes(OSC_TITLE),
      'a planted escape sequence from the commit subject reached the frame');
  });

  reg.define(/^the pane shows the printable characters of that subject$/, (w) => {
    for (const part of w.subjectParts) {
      assert.ok(w.plain.includes(part),
        `the printable "${part}" of the subject is missing:\n${w.plain}`);
    }
  });

  reg.define(/^the pane emits no escape sequence taken from that branch name$/, (w) => {
    assert.ok(!w.frame.includes(CLEAR_SCREEN),
      'the planted escape sequence from the branch name reached the frame');
  });

  reg.define(/^the pane shows "([^"]+)"$/, (w, text) => {
    assert.ok(w.plain.split('\n').some((/** @type {string} */ l) => l.includes(text)),
      `"${text}" is missing from:\n${w.plain}`);
  });

  reg.define(/^cycling still reaches the economy panel$/, (w) => {
    // Through the production pair: the request file the host key writes, then
    // the tick that consumes it. From the git pane, one press in a two-view
    // cycle must land on economy — meters and all.
    tick(w); // establish the loop's own view state
    const res = cycleView(w.stateDir);
    assert.ok(res.ok, `the cycle key could not record a request: ${res.reason}`);
    let p = '';
    for (let i = 0; i < 4 && !/economy/.test(p.split('\n')[0] || ''); i += 1) {
      p = tick(w).replace(/\x1b\[[0-9;]*m/g, '');
      if (!/economy/.test(p.split('\n')[0] || '')) {
        const again = cycleView(w.stateDir);
        assert.ok(again.ok, `the cycle key could not record a request: ${again.reason}`);
      }
    }
    assert.ok(/economy/.test(p.split('\n')[0] || '') && /[▓░]/.test(p),
      `cycling never reached a drawing economy panel:\n${p}`);
  });

  reg.define(/^the sidebar redraws again on its next tick$/, (w) => {
    const p = tick(w);
    assert.ok(p.length > 0, 'the next tick painted nothing — the draw loop wedged');
  });

  reg.define(/^no file in the repo is created, changed or deleted$/, (w) => {
    assert.deepStrictEqual(snapshot(w.repo), w.before,
      '100 renders left the repository different from how they found it');
  });

  reg.define(/^the pane holds no capability to run a command$/, () => {
    // Structural, against the module graph itself — the same walk
    // test/sidecar-capabilities.test.js pins, asserted here so the scenario
    // named in the feature carries the proof rather than pointing at it.
    const ROOT = path.join(__dirname, '..', '..');
    /** @type {Set<string>} */
    const bare = new Set();
    /** @type {Set<string>} */
    const seen = new Set();
    (function walk(/** @type {string} */ file) {
      const resolved = require.resolve(file);
      if (seen.has(resolved) || !resolved.startsWith(ROOT) || resolved.includes('node_modules')) return;
      seen.add(resolved);
      const src = fs.readFileSync(resolved, 'utf8');
      for (const m of src.matchAll(/require\(\s*'([^']+)'\s*\)/g)) {
        if (m[1].startsWith('.')) walk(path.join(path.dirname(resolved), m[1]));
        else bare.add(m[1].replace(/^node:/, ''));
      }
    })(path.join(ROOT, 'src', 'sidecar.js'));
    const held = FORBIDDEN_BUILTINS.filter((b) => bare.has(b));
    assert.deepStrictEqual(held, [],
      `the sidecar's module graph reaches capability builtins: ${held.join(', ')}`);
  });
};
